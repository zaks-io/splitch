import { CreateAppResponseSchema, deriveSlug } from "@splitch/contracts";
import type { HandlerArgs } from "@splitch/worker-runtime";
import {
  type AppEnvironmentDeps,
  type AppRow,
  appResponse,
  appSlugConflict,
  environmentResponse,
  nowIso,
  organizationNotFound,
  unusableAppKey,
} from "./app-environment-model";
import { provisionAppCreateState } from "./app-create-provisioning";
import { randomHex } from "./credential-cache";
import {
  createIdempotencyConflict,
  createIdempotencyKey,
  createRequestHash,
} from "./create-idempotency";
import { objectBody, pathParam } from "./handler-input";
import { ORG_ADMIN_ROLES, requireOrgRole } from "./org-authz";

interface AppCreateIntent {
  name: string;
  key: string;
  description?: string;
  idempotencyKey?: string;
  requestHash?: string;
}

export async function createAppRequest(
  deps: AppEnvironmentDeps,
  { input, principal, requestId, request }: HandlerArgs<unknown>,
): Promise<Response> {
  const orgId = pathParam(input, "orgId");
  const forbidden = await requireOrgRole(deps, orgId, principal, ORG_ADMIN_ROLES, requestId);
  if (forbidden) return forbidden;
  if (!(await deps.repo.identity.getOrg(orgId))) return organizationNotFound(requestId);

  const intent = await appCreateIntent(objectBody(input), request, requestId);
  if (!intent.ok) return intent.response;
  const replay = await replayAppCreateIntent(deps, orgId, principal.id, intent.value, requestId);
  if (replay) return replay;
  if (await appKeyExists(deps, orgId, intent.value.key)) {
    return appSlugConflict(intent.value.key, requestId);
  }

  const inserted = await insertCreatedApp(deps, orgId, principal.id, intent.value, requestId);
  if (!inserted.ok) return inserted.response;
  return provisionCreatedApp(deps, inserted.app, principal.id, intent.value.idempotencyKey);
}

async function appCreateIntent(
  body: Record<string, unknown>,
  request: Request,
  requestId: string,
): Promise<{ ok: true; value: AppCreateIntent } | { ok: false; response: Response }> {
  const name = body.name as string;
  // Derivation can legitimately fail, so fail loud instead of inventing a key.
  const key = typeof body.key === "string" ? body.key : deriveSlug(name);
  if (!key) return { ok: false, response: unusableAppKey(name, requestId) };
  const description = typeof body.description === "string" ? body.description : undefined;
  const idempotencyKey = createIdempotencyKey(body, request);
  const requestHash = idempotencyKey
    ? await createRequestHash({ name, key, ...(description ? { description } : {}) })
    : undefined;
  return {
    ok: true,
    value: { name, key, ...(description ? { description } : {}), idempotencyKey, requestHash },
  };
}

async function insertCreatedApp(
  deps: AppEnvironmentDeps,
  orgId: string,
  actorId: string,
  intent: AppCreateIntent,
  requestId: string,
): Promise<{ ok: true; app: AppRow } | { ok: false; response: Response }> {
  const now = nowIso(deps);
  try {
    const app = await deps.repo.identity.createApp({
      id: `app_${randomHex(12)}`,
      organizationId: orgId,
      name: intent.name,
      key: intent.key,
      ...(intent.description ? { description: intent.description } : {}),
      ...(intent.idempotencyKey
        ? {
            createIdempotencyKey: intent.idempotencyKey,
            createRequestHash: intent.requestHash,
          }
        : {}),
      createdAt: now,
      updatedAt: now,
      createdBy: actorId,
    });
    return { ok: true, app };
  } catch (cause) {
    const replay = await replayAppCreateIntent(deps, orgId, actorId, intent, requestId);
    if (replay) return { ok: false, response: replay };
    if (await appKeyExists(deps, orgId, intent.key)) {
      return { ok: false, response: appSlugConflict(intent.key, requestId) };
    }
    throw cause;
  }
}

async function provisionCreatedApp(
  deps: AppEnvironmentDeps,
  app: AppRow,
  actorId: string,
  idempotencyKey?: string,
): Promise<Response> {
  const response = await provisionedAppResponse(deps, app, actorId);
  if (idempotencyKey) {
    await deps.repo.identity.completeAppCreate(app.id, JSON.stringify(response));
  }
  return Response.json(response);
}

function appKeyExists(deps: AppEnvironmentDeps, orgId: string, key: string): Promise<boolean> {
  return deps.repo.identity
    .listAppsForOrg(orgId)
    .then((apps) => apps.some((candidate) => candidate.key === key));
}

function replayAppCreateIntent(
  deps: AppEnvironmentDeps,
  orgId: string,
  actorId: string,
  intent: AppCreateIntent,
  requestId: string,
): Promise<Response | null> {
  if (!intent.idempotencyKey || !intent.requestHash) return Promise.resolve(null);
  return replayCreatedApp(
    deps,
    orgId,
    actorId,
    intent.idempotencyKey,
    intent.requestHash,
    requestId,
  );
}

async function replayCreatedApp(
  deps: AppEnvironmentDeps,
  orgId: string,
  actorId: string,
  idempotencyKey: string,
  requestHash: string,
  requestId: string,
): Promise<Response | null> {
  const app = await deps.repo.identity.getAppCreateByIdempotency(orgId, actorId, idempotencyKey);
  if (!app) return null;
  if (app.createRequestHash !== requestHash) {
    return createIdempotencyConflict("app", idempotencyKey, requestId);
  }
  if (app.createResponse) {
    return Response.json(CreateAppResponseSchema.parse(JSON.parse(app.createResponse)));
  }

  const response = await provisionedAppResponse(deps, app, actorId);
  await deps.repo.identity.completeAppCreate(app.id, JSON.stringify(response));
  return Response.json(response);
}

async function provisionedAppResponse(deps: AppEnvironmentDeps, app: AppRow, actorId: string) {
  const { dev, prod, clientKeys } = await provisionAppCreateState(deps, app, actorId);
  return CreateAppResponseSchema.parse({
    app: appResponse(app),
    environments: [environmentResponse(dev), environmentResponse(prod)],
    clientKeys,
  });
}

import type { Repository } from "@splitch/db";
import { appScope } from "@splitch/db";
import { type HandlerArgs, type Registrar, renderError } from "@splitch/worker-runtime";
import type { Hono } from "hono";
import { requireAppWrite } from "./app-authz";
import { type EntityPrivacyConsumer, EntityPrivacyConsumerError } from "./entity-privacy-consumer";
import { objectBody, pathParam } from "./handler-input";
import { controlPlaneRoute } from "./routes";

const ACK_MS = 10 * 24 * 60 * 60 * 1000;
const RESPONSE_MS = 30 * 24 * 60 * 60 * 1000;

function makeEntityPrivacyHandlers(deps: {
  repo: Repository;
  entityPrivacy?: EntityPrivacyConsumer;
  nowIso?: () => string;
}) {
  return {
    exportEntity: entityPrivacyHandler(deps, "export"),
    deleteEntity: entityPrivacyHandler(deps, "delete"),
  };
}

export function mountEntityPrivacyRoutes(
  app: Hono,
  registrar: Registrar,
  deps: {
    repo: Repository;
    entityPrivacy?: EntityPrivacyConsumer;
    nowIso?: () => string;
  },
): void {
  const handlers = makeEntityPrivacyHandlers(deps);
  registrar.mount(app, controlPlaneRoute("entity_privacy_export"), handlers.exportEntity);
  registrar.mount(app, controlPlaneRoute("entity_privacy_delete"), handlers.deleteEntity);
}

function entityPrivacyHandler(
  deps: {
    repo: Repository;
    entityPrivacy?: EntityPrivacyConsumer;
    nowIso?: () => string;
  },
  kind: "export" | "delete",
) {
  return async (args: HandlerArgs<unknown>): Promise<Response> => {
    const appId = pathParam(args.input, "appId");
    const authorizationError = await requireAppWrite(deps, appId, args.principal, args.requestId);
    if (authorizationError) return authorizationError;
    if (!deps.entityPrivacy) return unavailable(args.requestId);
    return completeEntityPrivacy(deps, deps.entityPrivacy, kind, args, appId);
  };
}

async function completeEntityPrivacy(
  deps: { repo: Repository; nowIso?: () => string },
  consumer: EntityPrivacyConsumer,
  kind: "export" | "delete",
  args: HandlerArgs<unknown>,
  appId: string,
): Promise<Response> {
  const body = objectBody(args.input);
  const idType = stringField(body, "idType");
  const targetingKey = stringField(body, "targetingKey");
  const app = await deps.repo.identity.getApp(appId);
  if (!app) {
    return renderError(
      { code: "APP_NOT_FOUND", message: "app not found", details: {} },
      { requestId: args.requestId },
    );
  }
  try {
    const storeInput = {
      appId,
      idType,
      targetingKey,
      actorId: args.principal.id,
      orgId: args.principal.orgId,
      requestId: args.requestId,
    };
    let storeResult: Awaited<ReturnType<EntityPrivacyConsumer["exportEntity"]>>;
    if (kind === "export") {
      storeResult = await consumer.exportEntity(storeInput);
    } else {
      const identity = await consumer.exportEntity(storeInput);
      const deleteBeforeTs = deps.nowIso?.() ?? new Date().toISOString();
      await consumer.suppressEntity(storeInput, identity, deleteBeforeTs);
      await insertEntityDeletions(deps, appId, idType, identity.targetingKeyHashes, deleteBeforeTs);
      storeResult = await consumer.deleteEntity(storeInput, identity, deleteBeforeTs);
      assertSameHashes(identity.targetingKeyHashes, storeResult.targetingKeyHashes);
    }
    return Response.json(await recordPrivacyCompletion(deps, app, kind, args, storeResult));
  } catch (cause) {
    if (cause instanceof EntityPrivacyConsumerError) {
      return renderError(
        { code: "SERVICE_UNAVAILABLE", message: cause.message, details: { retryAfterMs: 1000 } },
        { requestId: args.requestId },
      );
    }
    throw cause;
  }
}

function assertSameHashes(expected: readonly string[], actual: readonly string[]): void {
  if (expected.length !== actual.length || expected.some((hash, index) => hash !== actual[index])) {
    throw new EntityPrivacyConsumerError(
      "control-plane-api: Entity identity changed between suppression and purge",
    );
  }
}

async function recordPrivacyCompletion(
  deps: { repo: Repository; nowIso?: () => string },
  app: { id: string; organizationId: string },
  kind: "export" | "delete",
  args: HandlerArgs<unknown>,
  storeResult: { targetingKeyHashes: readonly string[] },
) {
  const receivedAt = deps.nowIso?.() ?? new Date().toISOString();
  const receivedMs = Date.parse(receivedAt);
  const request = await deps.repo.privacy.createPrivacyRequest({
    requestId: `prv_${crypto.randomUUID()}`,
    orgId: app.organizationId,
    appId: app.id,
    requestType: kind === "export" ? "export" : "delete",
    subjectType: "entity",
    subjectRef: JSON.stringify(storeResult.targetingKeyHashes),
    requestedBy: args.principal.id,
    status: "completed",
    receivedAt,
    ackDueAt: new Date(receivedMs + ACK_MS).toISOString(),
    responseDueAt: new Date(receivedMs + RESPONSE_MS).toISOString(),
    completedAt: receivedAt,
  });
  return {
    request: {
      requestId: request.requestId,
      organizationId: request.orgId,
      appId: request.appId,
      requestType: request.requestType,
      subjectType: request.subjectType,
      status: request.status,
      receivedAt: request.receivedAt,
    },
    job: {
      jobId: `job_${request.requestId}`,
      requestId: request.requestId,
      kind,
      status: "completed",
    },
  };
}

async function insertEntityDeletions(
  deps: { repo: Repository },
  appId: string,
  idType: string,
  targetingKeyHashes: readonly string[],
  deleteBeforeTs: string,
): Promise<void> {
  for (const targetingKeyHash of targetingKeyHashes) {
    await deps.repo.privacy.entityDeletions.insert(appScope(appId), {
      appId,
      idType,
      targetingKeyHash,
      deleteBeforeTs,
      requestedAt: deleteBeforeTs,
    });
  }
}

function unavailable(requestId: string): Response {
  return renderError(
    {
      code: "SERVICE_UNAVAILABLE",
      message: "operation is not available yet",
      details: { retryAfterMs: 1000 },
    },
    { requestId },
  );
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`entity privacy is missing ${key}`);
  }
  return field;
}

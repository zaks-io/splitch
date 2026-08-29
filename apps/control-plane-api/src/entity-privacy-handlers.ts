import type { Repository } from "@splitch/db";
import { type HandlerArgs, type Registrar, renderError } from "@splitch/worker-runtime";
import type { Hono } from "hono";
import { requireAppWrite } from "./app-authz";
import type { ConfigStoreAccess } from "./config-store-access";
import type { EntityPrivacyConsumer } from "./entity-privacy-consumer";
import { EntityPrivacyConsumerError } from "./entity-privacy-service-client";
import { objectBody, pathParam } from "./handler-input";
import { controlPlaneRoute } from "./routes";
import { authorizePrivacyRequestStatus } from "./unavailable-handler";

const ACK_MS = 10 * 24 * 60 * 60 * 1000;
const RESPONSE_MS = 30 * 24 * 60 * 60 * 1000;

function makeEntityPrivacyHandlers(deps: {
  repo: Repository;
  entityPrivacy?: EntityPrivacyConsumer;
  configStore?: ConfigStoreAccess;
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
    configStore?: ConfigStoreAccess;
    nowIso?: () => string;
  },
): void {
  const handlers = makeEntityPrivacyHandlers(deps);
  registrar.mount(app, controlPlaneRoute("entity_privacy_export"), handlers.exportEntity);
  registrar.mount(app, controlPlaneRoute("entity_privacy_delete"), handlers.deleteEntity);
  registrar.mount(app, controlPlaneRoute("privacy_requests_get"), privacyStatusHandler(deps));
}

function entityPrivacyHandler(
  deps: {
    repo: Repository;
    entityPrivacy?: EntityPrivacyConsumer;
    configStore?: ConfigStoreAccess;
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
  deps: { repo: Repository; configStore?: ConfigStoreAccess; nowIso?: () => string },
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
    const coordinator = requireEntityPrivacyCoordinator(deps.configStore);
    const identityVersion = await coordinator.beginEntityPrivacy(appId);
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
      await coordinator.recordEntityDeletionSuppression(appId, identityVersion, {
        idType,
        targetingKeyHashes: identity.targetingKeyHashes,
        deleteBeforeTs,
      });
      storeResult = await consumer.deleteEntity(storeInput, identity, deleteBeforeTs);
      assertSameHashes(identity.targetingKeyHashes, storeResult.targetingKeyHashes);
    }
    return Response.json(
      await recordPrivacyCompletion(
        deps,
        app,
        kind,
        args,
        storeResult,
        identityVersion,
        coordinator,
      ),
    );
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
  storeResult: {
    targetingKeyHashes: readonly string[];
    exportArtifact?: unknown;
  },
  identityVersion: string,
  coordinator: Required<
    Pick<
      ConfigStoreAccess,
      "beginEntityPrivacy" | "recordEntityDeletionSuppression" | "recordEntityPrivacyCompletion"
    >
  >,
) {
  const receivedAt = deps.nowIso?.() ?? new Date().toISOString();
  const receivedMs = Date.parse(receivedAt);
  const request = await coordinator.recordEntityPrivacyCompletion(app.id, identityVersion, {
    requestId: `prv_${crypto.randomUUID()}`,
    orgId: app.organizationId,
    appId: app.id,
    requestType: kind === "export" ? "export" : "delete",
    subjectRef: JSON.stringify(storeResult.targetingKeyHashes),
    requestedBy: args.principal.id,
    receivedAt,
    ackDueAt: new Date(receivedMs + ACK_MS).toISOString(),
    responseDueAt: new Date(receivedMs + RESPONSE_MS).toISOString(),
    completedAt: receivedAt,
    resultJson:
      kind === "export" ? JSON.stringify(requireExportArtifact(storeResult.exportArtifact)) : null,
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
    artifact: kind === "export" ? requireExportArtifact(storeResult.exportArtifact) : null,
  };
}

function requireEntityPrivacyCoordinator(
  configStore: ConfigStoreAccess | undefined,
): Required<
  Pick<
    ConfigStoreAccess,
    "beginEntityPrivacy" | "recordEntityDeletionSuppression" | "recordEntityPrivacyCompletion"
  >
> {
  if (
    !configStore?.beginEntityPrivacy ||
    !configStore.recordEntityDeletionSuppression ||
    !configStore.recordEntityPrivacyCompletion
  ) {
    throw new EntityPrivacyConsumerError(
      "control-plane-api: Entity privacy identity coordinator is unavailable",
    );
  }
  return configStore as Required<
    Pick<
      ConfigStoreAccess,
      "beginEntityPrivacy" | "recordEntityDeletionSuppression" | "recordEntityPrivacyCompletion"
    >
  >;
}

function requireExportArtifact(value: unknown): unknown {
  if (typeof value !== "object" || value === null) {
    throw new EntityPrivacyConsumerError("control-plane-api: Entity export omitted its artifact");
  }
  return value;
}

function privacyStatusHandler(deps: { repo: Repository }) {
  return async (args: HandlerArgs<unknown>): Promise<Response> => {
    const authorizationError = await authorizePrivacyRequestStatus(deps, args);
    if (authorizationError) return authorizationError;
    const request = await deps.repo.privacy.getPrivacyRequestById(
      pathParam(args.input, "requestId"),
    );
    if (!request) throw new Error("authorized privacy request disappeared");
    return Response.json(privacyStatusResponse(request));
  };
}

function privacyStatusResponse(
  request: NonNullable<Awaited<ReturnType<Repository["privacy"]["getPrivacyRequestById"]>>>,
) {
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
    job: privacyStatusJob(request.requestId, request.requestType, request.status),
    artifact: request.resultJson ? parseArtifact(request.resultJson) : null,
  };
}

function privacyStatusJob(requestId: string, requestType: string, status: string) {
  if (requestType !== "export" && requestType !== "delete") return null;
  return {
    jobId: `job_${requestId}`,
    requestId,
    kind: requestType,
    status: status === "completed" ? "completed" : "running",
  };
}

function parseArtifact(value: string): unknown {
  const parsed: unknown = JSON.parse(value);
  return requireExportArtifact(parsed);
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

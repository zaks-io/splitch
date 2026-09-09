import { canonicalHash } from "@splitch/contracts";
import type { Repository } from "@splitch/db";
import { type HandlerArgs, type Registrar, renderError } from "@splitch/worker-runtime";
import type { Hono } from "hono";
import { requireAppWrite } from "./app-authz";
import type { ConfigStoreAccess } from "./config-store-access";
import type { EntityPrivacyConsumer } from "./entity-privacy-consumer";
import { initialEntityDeleteStoreStatus } from "./entity-privacy-delete-job";
import { initialEntityExportStoreStatus, type PrivacyJobMessage } from "./entity-privacy-jobs";
import { EntityPrivacyConsumerError } from "./entity-privacy-service-client";
import { objectBody, pathParam } from "./handler-input";
import {
  handlePrivacyExportDownload,
  privacyExportDownloadFields,
} from "./privacy-export-download";
import { controlPlaneRoute } from "./routes";
import { authorizePrivacyRequestStatus } from "./unavailable-handler";

const ACK_MS = 10 * 24 * 60 * 60 * 1000;
const RESPONSE_MS = 30 * 24 * 60 * 60 * 1000;

type EntityPrivacyDeps = {
  repo: Repository;
  entityPrivacy?: EntityPrivacyConsumer;
  configStore?: ConfigStoreAccess;
  privacyJobs?: Queue<PrivacyJobMessage>;
  privacyExports?: R2Bucket;
  privacyExportUrlSecret?: string;
  controlPlaneOrigin?: string;
  nowIso?: () => string;
};

export function mountEntityPrivacyRoutes(
  app: Hono,
  registrar: Registrar,
  deps: EntityPrivacyDeps,
): void {
  registrar.mount(
    app,
    controlPlaneRoute("entity_privacy_export"),
    entityPrivacyHandler(deps, "export"),
  );
  registrar.mount(
    app,
    controlPlaneRoute("entity_privacy_delete"),
    entityPrivacyHandler(deps, "delete"),
  );
  registrar.mount(app, controlPlaneRoute("privacy_requests_get"), privacyStatusHandler(deps));
  app.get("/privacy/requests/:requestId/download", async (c) => {
    if (!deps.privacyExports) return unavailable("privacy-download");
    return handlePrivacyExportDownload({
      repo: deps.repo,
      bucket: deps.privacyExports,
      request: c.req.raw,
      requestId: c.req.param("requestId"),
      secret: deps.privacyExportUrlSecret,
      now: deps.nowIso ? new Date(deps.nowIso()) : undefined,
    });
  });
}

function entityPrivacyHandler(deps: EntityPrivacyDeps, kind: "export" | "delete") {
  return async (args: HandlerArgs<unknown>): Promise<Response> => {
    const appId = pathParam(args.input, "appId");
    const authorizationError = await requireAppWrite(deps, appId, args.principal, args.requestId);
    if (authorizationError) return authorizationError;
    if (!deps.entityPrivacy) return unavailable(args.requestId);
    if (!deps.privacyJobs) return unavailable(args.requestId);
    return intakeEntity(deps, deps.entityPrivacy, args, appId, kind);
  };
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Intake keeps authorization, identity resolution, idempotency, and durable queue publication in one auditable transaction boundary.
async function intakeEntity(
  deps: EntityPrivacyDeps,
  consumer: EntityPrivacyConsumer,
  args: HandlerArgs<unknown>,
  appId: string,
  kind: "export" | "delete",
): Promise<Response> {
  const body = objectBody(args.input);
  const idType = stringField(body, "idType");
  const targetingKey = stringField(body, "targetingKey");
  const idempotencyKey = args.request.headers.get("idempotency-key");
  if (!idempotencyKey) throw new Error(`entity privacy ${kind} requires Idempotency-Key`);
  const app = await deps.repo.identity.getApp(appId);
  if (!app) return appNotFound(args.requestId);

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
    const identity = await consumer.resolveIdentity(storeInput);
    const requestHash = await canonicalHash({
      appId,
      idType,
      targetingKeyHashes: identity.targetingKeyHashes,
      kind,
    });
    const stableId = (
      await canonicalHash({
        appId,
        requestedBy: args.principal.id,
        kind,
        idempotencyKey,
      })
    ).slice("sha256:".length);
    const receivedAt = deps.nowIso?.() ?? new Date().toISOString();
    const receivedMs = Date.parse(receivedAt);
    const intake = await coordinator.recordEntityPrivacyRequest(appId, identityVersion, {
      requestId: `prv_${stableId}`,
      jobId: `job_${stableId}`,
      orgId: app.organizationId,
      appId,
      requestType: kind,
      subjectRef: JSON.stringify(identity.targetingKeyHashes),
      requestedBy: args.principal.id,
      receivedAt,
      ackDueAt: new Date(receivedMs + ACK_MS).toISOString(),
      responseDueAt: new Date(receivedMs + RESPONSE_MS).toISOString(),
      idempotencyKey,
      requestHash,
      storeStatusJson: JSON.stringify(
        kind === "delete" ? initialEntityDeleteStoreStatus() : initialEntityExportStoreStatus(),
      ),
      deleteBeforeTs: kind === "delete" ? receivedAt : null,
      identityVersion,
      idType,
      entityFamilyHash: identity.entityFamilyHash,
    });
    if (intake.request.requestHash !== requestHash) {
      return idempotencyConflict(kind, idempotencyKey, args.requestId);
    }
    if (intake.job.identityVersion !== identityVersion) {
      throw new EntityPrivacyConsumerError(
        "control-plane-api: App identity changed after Entity privacy intake",
      );
    }
    if (intake.job.status !== "completed") {
      await deps.privacyJobs?.send({ requestId: intake.request.requestId });
    }
    return Response.json(
      await privacyStatusResponse(deps, intake.request.requestId, args.request.url),
    );
  } catch (cause) {
    if (cause instanceof EntityPrivacyConsumerError)
      return consumerUnavailable(cause, args.requestId);
    throw cause;
  }
}

function privacyStatusHandler(deps: { repo: Repository }) {
  return async (args: HandlerArgs<unknown>): Promise<Response> => {
    const authorizationError = await authorizePrivacyRequestStatus(deps, args);
    if (authorizationError) return authorizationError;
    return Response.json(
      await privacyStatusResponse(deps, pathParam(args.input, "requestId"), args.request.url),
    );
  };
}

async function privacyStatusResponse(
  deps: EntityPrivacyDeps,
  requestId: string,
  requestUrl: string,
) {
  const repo = deps.repo;
  const [request, job] = await Promise.all([
    repo.privacy.getPrivacyRequestById(requestId),
    repo.privacy.getPrivacyJobByRequestId(requestId),
  ]);
  if (!request) throw new Error("authorized privacy request disappeared");
  const download = await privacyExportDownloadFields({
    repo,
    requestId,
    requestUrl,
    origin: deps.controlPlaneOrigin,
    secret: deps.privacyExportUrlSecret,
    now: deps.nowIso ? new Date(deps.nowIso()) : undefined,
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
    job: job
      ? {
          jobId: job.jobId,
          requestId: job.requestId,
          kind: job.kind,
          status: job.status,
          storeStatus: JSON.parse(job.storeStatusJson) as Record<string, string>,
          ...download,
        }
      : null,
  };
}

function requireEntityPrivacyCoordinator(configStore: ConfigStoreAccess | undefined) {
  if (
    !configStore?.beginEntityPrivacy ||
    !configStore.recordEntityDeletionSuppression ||
    !configStore.recordEntityPrivacyRequest
  ) {
    throw new EntityPrivacyConsumerError(
      "control-plane-api: Entity privacy identity coordinator is unavailable",
    );
  }
  return {
    beginEntityPrivacy: configStore.beginEntityPrivacy.bind(configStore),
    recordEntityDeletionSuppression: configStore.recordEntityDeletionSuppression.bind(configStore),
    recordEntityPrivacyRequest: configStore.recordEntityPrivacyRequest.bind(configStore),
  };
}

function appNotFound(requestId: string): Response {
  return renderError(
    { code: "APP_NOT_FOUND", message: "app not found", details: {} },
    { requestId },
  );
}

function idempotencyConflict(
  kind: "export" | "delete",
  idempotencyKey: string,
  requestId: string,
): Response {
  return renderError(
    {
      code: "IDEMPOTENCY_KEY_CONFLICT",
      message: "idempotency key was already used for a different Entity privacy request",
      details: { scope: `entity_privacy_${kind}` as const, idempotencyKey },
    },
    { requestId },
  );
}

function consumerUnavailable(cause: EntityPrivacyConsumerError, requestId: string): Response {
  return renderError(
    { code: "SERVICE_UNAVAILABLE", message: cause.message, details: { retryAfterMs: 1000 } },
    { requestId },
  );
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

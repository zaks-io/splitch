import { WorkerEntrypoint } from "cloudflare:workers";
import {
  createHealthResponse,
  getRoute,
  requirePlatformTarget,
  routesDelegatedTo,
} from "@splitch/contracts";
import {
  createWorkerObservability,
  workerObservabilityWithWaitUntil,
  wrapWorkerHandler,
} from "@splitch/observability/worker";
import {
  delegatedIdentityFor,
  notDelegatedResponse,
  type Observability,
} from "@splitch/worker-runtime";
import { authenticateDelegatedDataPlaneCredential } from "./client-key-auth";
import { appIdentityPrivacyInventoryStub } from "./entity-metric-privacy";
import {
  handleEntityMetricPrivacy,
  requireEntityMetricPrivacyBinding,
} from "./entity-metric-privacy-handler";
import { EntityMetricPrivacyDurableObject } from "./entity-metric-privacy-store";
import { renderError } from "./errors";
import { handleEvaluationCommit } from "./evaluation-commit";
import { EvaluationCommitOutboxDurableObject } from "./evaluation-commit-outbox";
import { EvaluationUsageReplayWindowDurableObject } from "./evaluation-usage-replay-window";
import { handleEvaluationIngest, handleIngest } from "./ingest";
import { IngestAdmissionGateDurableObject } from "./ingest-admission-gate";
import { createIngestPhaseTiming, ingestTimingOutcomeFor } from "./ingest-phase-timing";
import { handleAuthorizedMetricEvent } from "./metric-event-ingest";
import { MetricEventOutboxDurableObject } from "./metric-event-outbox";
import { handleMetricEventQueue } from "./metric-event-queue";
import { MetricEventRateLimitDurableObject } from "./metric-event-rate-limit";
import { handleMetricEventReconciliationQueue } from "./metric-event-reconciliation";
import { makeMetricEventSaltStore } from "./metric-event-salt-store";
import { handleRawEventQueue } from "./raw-event-queue";
import type { Env } from "./types";

const service = "splitch-event-ingest-api";
const ingestPath = "/api/internal/exposures";
const evaluationIngestPath = "/api/internal/evaluations";
const evaluationCommitPath = "/api/internal/evaluation-commits";
const metricEventPath = "/api/sdk/events";
const rawEventQueueNames = new Set([
  "splitch-raw-events-local",
  "splitch-raw-evaluations-local",
  "splitch-raw-events-shared-preview",
  "splitch-raw-evaluations-shared-preview",
  "splitch-raw-events",
  "splitch-raw-evaluations",
]);
const metricEventQueueNames = new Set([
  "splitch-metric-events-local",
  "splitch-metric-events-shared-preview",
  "splitch-metric-events",
]);
const metricEventReconciliationQueueNames = new Set([
  "splitch-metric-events-reconciliation-local",
  "splitch-metric-events-reconciliation-shared-preview",
  "splitch-metric-events-reconciliation",
]);
const metricEventRoutes = routesDelegatedTo("event-ingest-api").filter(
  (route) => route.operationId === "sdk_track",
);
const entityPrivacyOperations = [
  "entity_event_privacy_export",
  "entity_event_privacy_suppress",
  "entity_event_privacy_delete",
] as const;
const entityPrivacyRoutes = entityPrivacyOperations.map((operationId) => {
  const route = getRoute(operationId);
  if (!route) throw new Error(`event-ingest-api: ${operationId} route is not registered`);
  return route;
});

/**
 * Binding-only writes the Evaluation Worker makes for its own App and
 * Environment scope: sealed Exposures, Evaluation commits and Evaluation
 * usage. The public hostname never mounts these paths. The shared token is
 * defense in depth on the binding door, not a public credential, and each
 * handler re-derives Organization, App, and Environment scope from the
 * request only after that compare succeeds.
 */
const internalRoutes: Readonly<
  Record<
    string,
    {
      requestId: string;
      handle(request: Request, env: Env): Promise<Response>;
    }
  >
> = {
  [ingestPath]: { requestId: "ingest-request", handle: handleIngest },
  [evaluationIngestPath]: {
    requestId: "evaluation-ingest-request",
    handle: handleEvaluationIngest,
  },
  [evaluationCommitPath]: {
    requestId: "evaluation-commit-request",
    handle: handleEvaluationCommit,
  },
};

const handler = {
  async fetch(request, env): Promise<Response> {
    const platformTarget = requirePlatformTarget(env.SPLITCH_PLATFORM_TARGET);
    requireEntityMetricPrivacyBinding(env);
    const url = new URL(request.url);
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return healthResponse(env, platformTarget);
    }
    return new Response("not found", { status: 404 });
  },
  queue: handleQueue,
} satisfies ExportedHandler<Env, Record<string, unknown>>;

async function handleQueue(batch: MessageBatch<Record<string, unknown>>, env: Env): Promise<void> {
  if (rawEventQueueNames.has(batch.queue)) {
    return handleRawEventQueue(batch, env);
  }
  if (metricEventReconciliationQueueNames.has(batch.queue)) {
    return handleMetricEventReconciliationQueue(batch, env);
  }
  if (metricEventQueueNames.has(batch.queue)) return handleMetricEventQueue(batch, env);
  throw new Error(`event-ingest-api received an unknown queue: ${batch.queue}`);
}

/**
 * Everything `splitch-evaluation-api` may send over the single `EVENT_INGEST`
 * service binding.
 *
 * One binding carries four operations, so this entrypoint has to recognise all
 * four or the ones it misses fail closed on deploy: the three internal sinks
 * above, plus the delegated `sdk_track` Metric Event whose Client Key the
 * Evaluation Worker already authorized at the public edge. A second binding
 * would give the same caller two identities for no gain.
 */
const delegatedHandler = {
  async fetch(request, env, ctx): Promise<Response> {
    requirePlatformTarget(env.SPLITCH_PLATFORM_TARGET);
    makeMetricEventSaltStore(env);
    const url = new URL(request.url);
    const observability = observabilityFor(env, ctx);
    const internal = await handleInternalRoute(request, env, observability, url);
    if (internal) return internal;
    if (request.method !== "POST" || url.pathname !== metricEventPath) {
      return notDelegatedResponse(request);
    }
    const identity = delegatedIdentityFor(request, metricEventRoutes);
    if (!identity) return notDelegatedResponse(request);
    recordRequest(observability, request, url, "metric-event-request");
    const timing = createIngestPhaseTiming(env, {
      route: "sdk_metric_event",
      stream: "metric_events",
    });
    const credential = await timing.measure("auth", () =>
      authenticateDelegatedDataPlaneCredential(identity, env),
    );
    if (!credential.ok) {
      const response = renderError(credential.error);
      timing.emit(ingestTimingOutcomeFor(response), { serializedBytes: null });
      return response;
    }
    return handleAuthorizedMetricEvent(request, env, credential.value, timing);
  },
} satisfies ExportedHandler<Env>;

/** The public fetch must stay closed while Evaluation delegates over this binding. */
export class EvaluationEntrypoint extends WorkerEntrypoint<Env> {
  override async fetch(request: Request): Promise<Response> {
    return wrapWorkerHandler(delegatedHandler, { surface: "event-ingest-api" }).fetch(
      request as Parameters<typeof delegatedHandler.fetch>[0],
      this.env,
      this.ctx,
    );
  }
}

const controlPlaneHandler = {
  async fetch(request, env): Promise<Response> {
    requirePlatformTarget(env.SPLITCH_PLATFORM_TARGET);
    requireEntityMetricPrivacyBinding(env);
    const identity = delegatedIdentityFor(request, entityPrivacyRoutes);
    if (!identity) return notDelegatedResponse(request);
    const operationId = identity.operation;
    const operation = operationId.endsWith("_export")
      ? "export"
      : operationId.endsWith("_suppress")
        ? "suppress"
        : "delete";
    return handleEntityMetricPrivacy(request, env, identity, operation);
  },
} satisfies ExportedHandler<Env>;

export class ControlPlaneEntrypoint extends WorkerEntrypoint<Env> {
  override async fetch(request: Request): Promise<Response> {
    return wrapWorkerHandler(controlPlaneHandler, { surface: "event-ingest-api" }).fetch(
      request as Parameters<typeof controlPlaneHandler.fetch>[0],
      this.env,
      this.ctx,
    );
  }

  purgeAppIdentityDelivery(
    appId: string,
    resetId: string,
    currentVersion: string,
  ): Promise<string> {
    return purgeAppIdentityDelivery(this.env, appId, resetId, currentVersion);
  }

  completeAppIdentityReset(appId: string, resetId: string, nextVersion: string): Promise<void> {
    return completeAppIdentityReset(this.env, appId, resetId, nextVersion);
  }
}

async function purgeAppIdentityDelivery(
  env: Env,
  appId: string,
  resetId: string,
  currentVersion: string,
): Promise<string> {
  const response = await appIdentityPrivacyInventoryStub(env.ENTITY_METRIC_PRIVACY, appId).fetch(
    "https://entity-privacy.local/reset-app",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appId, resetId, currentVersion }),
    },
  );
  if (!response.ok) throw new Error(`Event delivery identity purge returned ${response.status}`);
  const body = (await response.json()) as { proof?: unknown };
  if (typeof body.proof !== "string")
    throw new Error("Event delivery identity purge omitted proof");
  return body.proof;
}

async function completeAppIdentityReset(
  env: Env,
  appId: string,
  resetId: string,
  nextVersion: string,
): Promise<void> {
  const response = await appIdentityPrivacyInventoryStub(env.ENTITY_METRIC_PRIVACY, appId).fetch(
    "https://entity-privacy.local/complete-reset",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resetId, nextVersion }),
    },
  );
  if (!response.ok) throw new Error(`Event identity reset completion returned ${response.status}`);
}

export default wrapWorkerHandler(handler, { surface: "event-ingest-api" });

function healthResponse(
  env: Env,
  platformTarget = requirePlatformTarget(env.SPLITCH_PLATFORM_TARGET),
): Response {
  requireEntityMetricPrivacyBinding(env);
  makeMetricEventSaltStore(env);
  return Response.json(
    createHealthResponse(service, platformTarget, env.SPLITCH_DEPLOYED_COMMIT_SHA),
  );
}

function observabilityFor(env: Env, ctx: ExecutionContext): Observability {
  return createWorkerObservability(env, workerObservabilityWithWaitUntil("event-ingest-api", ctx));
}

/** The internal sink for this request, or null when it is not one. */
async function handleInternalRoute(
  request: Request,
  env: Env,
  observability: Observability,
  url: URL,
): Promise<Response | null> {
  const route = request.method === "POST" ? internalRoutes[url.pathname] : undefined;
  if (route === undefined) return null;
  recordRequest(observability, request, url, route.requestId);
  return route.handle(request, env);
}

function recordRequest(
  observability: Observability,
  request: Request,
  url: URL,
  fallbackRequestId: string,
): void {
  observability.onRequest?.({
    requestId: request.headers.get("x-request-id") ?? fallbackRequestId,
    method: request.method,
    path: url.pathname,
  });
}

export {
  EntityMetricPrivacyDurableObject,
  EvaluationCommitOutboxDurableObject,
  EvaluationUsageReplayWindowDurableObject,
  IngestAdmissionGateDurableObject,
  MetricEventOutboxDurableObject,
  MetricEventRateLimitDurableObject,
};

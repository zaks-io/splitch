import { appScope, type Repository } from "@splitch/db";
import { createPerformanceSpanRecorder } from "@splitch/observability/performance-spans";
import {
  createWorkerFaultReporter,
  createWorkerObservability,
  serializeFault,
  workerObservabilityWithWaitUntil,
} from "@splitch/observability/worker";
import type { AuthResolver } from "@splitch/worker-runtime";
import { apiDocumentVersion } from "./api-document-version";
import { createApp } from "./app";
import { approvalArchiveStoreFromEnv } from "./approval-archive-tinybird";
import { createAnalysisResultsReader } from "./attention-analysis-reader";
import { forwardAuditEvents } from "./audit-events";
import { durableConfigStoreAccess } from "./config-store-access";
import { integrationDeliveryMode } from "./control-plane-runtime-config";
import { durableCredentialCacheWriterAccess } from "./credential-cache-writer-do";
import { createEntityPrivacyConsumer } from "./entity-privacy-consumer";
import type { ControlPlaneApiEnv } from "./env";
import { createHoldoverWriteOutboxCleanup } from "./holdover-write-outbox-cleanup";
import {
  dispatchAppIntegrationDelivery,
  integrationRegistrationWake,
} from "./integration-delivery-mutation";
import { makeSessionCacheMemberProfileResolver } from "./member-profile-cache";
import { rateLimiterForTarget } from "./rate-limit";
import { runSnapshotDeliveryFromEnv } from "./run-snapshot";
import { reportRunSnapshotFault } from "./run-snapshot-fault";

export async function handleControlPlaneAppRequest(input: {
  request: Request;
  env: ControlPlaneApiEnv;
  ctx: ExecutionContext;
  authResolver: AuthResolver;
  repo: Repository;
  door: "public" | "binding";
  delegated: boolean;
}): Promise<Response> {
  const { request, env, ctx, authResolver, repo, door, delegated } = input;
  let resolvedAppId: string | undefined;
  const mode = integrationDeliveryMode(env);
  const wakeDelivery = integrationRegistrationWake(env, ctx);
  const configStore = durableConfigStoreAccess(env.CONFIG_STORE_WRITER, env.CONFIG_STORE, {
    repo,
    waitUntil: (promise) => ctx.waitUntil(promise),
  });
  const app = createApp({
    onResolvedApp: (appId) => {
      resolvedAppId = appId;
    },
    door,
    apiVersion: () => apiDocumentVersion(env),
    authResolver,
    rateLimiter: rateLimiterForTarget(
      env.SPLITCH_PLATFORM_TARGET,
      env.CONTROL_PLANE_ACTOR_RATE_LIMITER,
    ),
    repo,
    credentialStore: env.CREDENTIAL_STORE,
    personalAccessTokenStore: env.SESSION_STORE,
    credentialCacheWriter: durableCredentialCacheWriterAccess(env.CREDENTIAL_CACHE_WRITER),
    configStore,
    eventDefinitionStore: env.CONFIG_STORE,
    runSnapshotDelivery: {
      ...runSnapshotDeliveryFromEnv(env),
      onFault: (detail) => reportRunSnapshotFault(env, ctx, detail),
    },
    logger: console,
    memberProfileResolver: makeSessionCacheMemberProfileResolver(env.SESSION_STORE),
    observability: createWorkerObservability(
      env,
      workerObservabilityWithWaitUntil("control-plane-api", ctx),
    ),
    analysisResults: createAnalysisResultsReader(
      env.ANALYSIS_API,
      undefined,
      configStore,
      createPerformanceSpanRecorder(env),
    ),
    analysis: env.ANALYSIS_API,
    delegationBindings: {
      "analysis-api": env.ANALYSIS_API,
      "evaluation-api": env.EVALUATION_API,
    },
    approvalArchiveStore: approvalArchiveStoreFromEnv(env),
    holdoverWriteOutboxCleanup: createHoldoverWriteOutboxCleanup(env.EVALUATION_API),
    entityPrivacy: createEntityPrivacyConsumer(
      env.EVALUATION_API,
      env.ANALYSIS_API,
      env.EVENT_INGEST_API,
    ),
    privacyJobs: env.PRIVACY_JOBS_QUEUE,
    privacyExports: env.PRIVACY_EXPORTS,
    privacyExportUrlSecret: env.PRIVACY_EXPORT_URL_SECRET,
    controlPlaneOrigin: env.CONTROL_PLANE_ORIGIN,
    sentry: {
      secretKek: env.INTEGRATION_SECRET_KEK,
      secretKeyVersion: env.INTEGRATION_SECRET_KEY_VERSION,
      allowedHosts: env.SENTRY_WEBHOOK_ALLOWED_HOSTS,
    },
    ...(delegated
      ? {
          convex: {
            wakeDelivery,
            webhookKek: env.CONVEX_WEBHOOK_KEK,
            webhookKeyVersion: env.CONVEX_WEBHOOK_KEY_VERSION,
          },
          cloudflare: {
            wakeDelivery,
            secretKek: env.INTEGRATION_SECRET_KEK,
            secretKeyVersion: env.INTEGRATION_SECRET_KEY_VERSION,
          },
        }
      : {}),
  });

  const response = await app.fetch(request, env);
  // A pending Approval Request is a committed mutation even when the route answers 409.
  if (resolvedAppId && request.method !== "GET" && request.method !== "HEAD") {
    ctx.waitUntil(
      forwardAuditEvents({ repo, env, scope: appScope(resolvedAppId) }).catch((error) => {
        reportMutationBackgroundFault(
          env,
          ctx,
          error,
          "audit-event-forward",
          "audit_event_forward_failed",
        );
        throw new Error("audit_event_forward_failed");
      }),
    );
  }
  if (response.ok && resolvedAppId && request.method !== "GET" && request.method !== "HEAD") {
    ctx.waitUntil(
      dispatchAppIntegrationDelivery(env, repo, resolvedAppId).catch((error) => {
        reportMutationBackgroundFault(
          env,
          ctx,
          error,
          mode === "cron" ? "cloudflare-push-dispatch" : "integration-delivery-wake",
          mode === "cron" ? "cloudflare_push_dispatch_failed" : "integration_delivery_wake_failed",
        );
        throw new Error(
          mode === "cron" ? "cloudflare_push_dispatch_failed" : "integration_delivery_wake_failed",
        );
      }),
    );
  }
  return response;
}

function reportMutationBackgroundFault(
  env: ControlPlaneApiEnv,
  ctx: Pick<ExecutionContext, "waitUntil">,
  error: unknown,
  job: string,
  code: string,
): void {
  createWorkerFaultReporter(env, workerObservabilityWithWaitUntil("control-plane-api", ctx))(code, {
    service: "splitch-control-plane-api",
    job,
    trigger: "mutation",
    fault: serializeFault(error),
  });
}

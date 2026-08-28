import type { Repository } from "@splitch/db";
import {
  createWorkerFaultReporter,
  createWorkerObservability,
  workerObservabilityWithWaitUntil,
} from "@splitch/observability/worker";
import type { AuthResolver } from "@splitch/worker-runtime";
import { createApp } from "./app";
import { approvalArchiveStoreFromEnv } from "./approval-archive-tinybird";
import { createAnalysisResultsReader } from "./attention-analysis-reader";
import { dispatchCloudflarePushes } from "./cloudflare-push-dispatch";
import { durableConfigStoreAccess } from "./config-store-do";
import { durableCredentialCacheWriterAccess } from "./credential-cache-writer-do";
import { createEntityPrivacyConsumer } from "./entity-privacy-consumer";
import type { ControlPlaneApiEnv } from "./env";
import { createHoldoverWriteOutboxCleanup } from "./holdover-write-outbox-cleanup";
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
  delegated: boolean;
}): Promise<Response> {
  const { request, env, ctx, authResolver, repo, delegated } = input;
  const configStore = durableConfigStoreAccess(env.CONFIG_STORE_WRITER);
  const app = createApp({
    door: delegated ? "binding" : "public",
    authResolver,
    rateLimiter: rateLimiterForTarget(
      env.SPLITCH_PLATFORM_TARGET,
      env.CONTROL_PLANE_ACTOR_RATE_LIMITER,
    ),
    repo,
    credentialStore: env.CREDENTIAL_STORE,
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
    analysisResults: createAnalysisResultsReader(env.ANALYSIS_API, undefined, configStore),
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
    sentry: {
      secretKek: env.INTEGRATION_SECRET_KEK,
      secretKeyVersion: env.INTEGRATION_SECRET_KEY_VERSION,
      allowedHosts: env.SENTRY_WEBHOOK_ALLOWED_HOSTS,
    },
    ...(delegated
      ? {
          convex: {
            webhookKek: env.CONVEX_WEBHOOK_KEK,
            webhookKeyVersion: env.CONVEX_WEBHOOK_KEY_VERSION,
          },
          cloudflare: {
            secretKek: env.INTEGRATION_SECRET_KEK,
            secretKeyVersion: env.INTEGRATION_SECRET_KEY_VERSION,
          },
        }
      : {}),
  });

  const response = await app.fetch(request, env);
  if (response.ok && request.method !== "GET" && request.method !== "HEAD") {
    ctx.waitUntil(
      dispatchCloudflarePushes({
        repo,
        secretKek: env.INTEGRATION_SECRET_KEK,
        secretKeyVersion: env.INTEGRATION_SECRET_KEY_VERSION,
      }).catch((error) => {
        reportCloudflarePushFault(env, ctx, error, "mutation");
        throw error;
      }),
    );
  }
  return response;
}

function reportCloudflarePushFault(
  env: ControlPlaneApiEnv,
  ctx: Pick<ExecutionContext, "waitUntil">,
  error: unknown,
  trigger: string,
): void {
  createWorkerFaultReporter(env, workerObservabilityWithWaitUntil("control-plane-api", ctx))(
    "cloudflare_push_dispatch_failed",
    {
      service: "splitch-control-plane-api",
      job: "cloudflare-push-dispatch",
      trigger,
      fault: error instanceof Error ? (error.stack ?? error.message) : String(error),
    },
  );
}

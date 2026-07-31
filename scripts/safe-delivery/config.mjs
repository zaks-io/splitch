/**
 * Environment contract for the shared-preview safe-delivery tracer.
 *
 * Only the credential and the deployed commit SHA fail loud: everything else
 * defaults to the seeded shared-preview smoke fixture, whose `dev` Environment
 * is `allow` and whose `prod` Environment is `confirm` on every change type.
 * That allow/confirm pair is what makes the confirm gate provable.
 */

import { requireFullCommitSha } from "../lib/shared-preview-deployment-evidence.mjs";

export function readConfig(env) {
  const clientSecret = env.SPLITCH_SMOKE_CLIENT_SECRET;
  if (!clientSecret) {
    throw new Error(
      "SPLITCH_SMOKE_CLIENT_SECRET is required for the shared-preview safe-delivery tracer",
    );
  }
  const commitSha = requireFullCommitSha(
    env.SPLITCH_SMOKE_COMMIT_SHA ?? env.SPLITCH_DEPLOYED_COMMIT_SHA,
    "SPLITCH_SMOKE_COMMIT_SHA",
  );
  const runId = (env.SPLITCH_SMOKE_RUN_ID ?? env.GITHUB_RUN_ID ?? String(Date.now()))
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]/g, "-")
    .slice(0, 24);

  return {
    clientSecret,
    commitSha,
    runId,
    runs: Math.max(1, Number(env.SPLITCH_SMOKE_RUNS ?? "2")),
    evidencePath:
      env.SPLITCH_SAFE_DELIVERY_EVIDENCE ??
      "test-results/shared-preview/safe-delivery-evidence.json",
    authBaseUrl: originUrl(env.SPLITCH_SMOKE_AUTH_BASE_URL, "https://auth.preview.splitch.dev"),
    controlPlaneBaseUrl: originUrl(
      env.SPLITCH_SMOKE_CONTROL_PLANE_BASE_URL,
      "https://api.preview.splitch.dev",
    ),
    evaluationBaseUrl: originUrl(
      env.SPLITCH_SMOKE_EVALUATION_BASE_URL,
      "https://edge.preview.splitch.dev",
    ),
    clientId: env.SPLITCH_SMOKE_CLIENT_ID ?? "splitch-shared-preview-smoke",
    appId: env.SPLITCH_SMOKE_APP_ID ?? "app_shared_preview_smoke",
    devEnvironmentId: env.SPLITCH_SMOKE_ENVIRONMENT_ID ?? "env_shared_preview_smoke_dev",
    prodEnvironmentId: env.SPLITCH_SMOKE_PROD_ENVIRONMENT_ID ?? "env_shared_preview_smoke_prod",
    otherAppEnvironmentId:
      env.SPLITCH_SMOKE_OTHER_ENVIRONMENT_ID ?? "env_shared_preview_smoke_other_dev",
    devClientKey: env.SPLITCH_SMOKE_ACTIVE_CLIENT_KEY ?? "pk_shared_preview_smoke_dev",
    prodClientKey: env.SPLITCH_SMOKE_PROD_CLIENT_KEY ?? "pk_shared_preview_smoke_prod",
    stableFlagKey: env.SPLITCH_SMOKE_STABLE_FLAG_KEY ?? "shared-preview-smoke",
    propagationWindowMs: Number(env.SPLITCH_SMOKE_PROPAGATION_WINDOW_MS ?? "60000"),
  };
}

function originUrl(value, fallback) {
  return new URL(value ?? fallback).origin;
}

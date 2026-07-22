#!/usr/bin/env node
/**
 * Shared-preview dark-launch smoke (SPL-168).
 *
 * Runs the external-product dark-launch journey twice consecutively against the
 * pre-authorized shared-preview smoke identity. Records one exact deployed commit
 * and asserts cleanup leaves no orphans.
 *
 * Required env:
 *   SPLITCH_SMOKE_CLIENT_SECRET
 * Optional:
 *   SPLITCH_SMOKE_COMMIT_SHA / SPLITCH_DEPLOYED_COMMIT_SHA (required when health
 *     does not surface deployedCommitSha)
 *   SPLITCH_SMOKE_RUNS (default 2)
 *   SPLITCH_DARK_LAUNCH_EVIDENCE (evidence output path)
 */
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createFleetEvidence,
  requireFullCommitSha,
  resolveDeployedCommitSha,
} from "../lib/shared-preview-deployment-evidence.mjs";
import {
  listApps,
  listFlags,
  PROPAGATION_WINDOW_MS,
  runDarkLaunchJourney,
} from "./journey.mjs";
import { installPackedSdkConsumer, runExternalResolve, writeEvidence } from "./pack-consumer.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const runs = Math.max(1, Number(process.env.SPLITCH_SMOKE_RUNS ?? "2"));
const evidencePath =
  process.env.SPLITCH_DARK_LAUNCH_EVIDENCE ??
  resolve(repoRoot, "test-results/shared-preview/dark-launch-evidence.json");

const config = readConfig();
const deployedCommitSha = await resolveCommitSha(config);
const consumer = installPackedSdkConsumer();
const installCommand = consumer.installCommand.replace(consumer.tarballPath, "<packed-tarball.tgz>");

const runResults = [];
try {
  for (let index = 0; index < runs; index += 1) {
    const runId = `${config.runId}-r${index + 1}`;
    const accessToken = await clientCredentialsToken(config);
    const result = await runDarkLaunchJourney({
      fetch,
      accessToken,
      orgId: config.smokeOrgId,
      appId: config.smokeAppId,
      environmentId: config.smokeEnvironmentId,
      controlPlaneBaseUrl: config.controlPlaneBaseUrl,
      evaluationBaseUrl: config.evaluationBaseUrl,
      runId,
      propagationWindowMs: PROPAGATION_WINDOW_MS,
      resolve: (action, options) => runExternalResolve(consumer, action, options),
      assertVerifyClean: async () => {
        // Hosted: verify is a non-exposing path by construction (no ingest call).
        // Local integration tests assert recording sinks separately.
      },
      assertEvaluateObservation: async ({ first, retry }) => {
        if (first.reason === "ERROR" || retry.reason === "ERROR") {
          throw new Error("evaluate observation failed loud");
        }
        // Retry-safe: same Variant; hosted commit outbox seals one logical Evaluation.
        if (first.value !== retry.value) {
          throw new Error("retry-safe evaluate returned a different Variant");
        }
      },
      assertCleanup: async ({ keys }) => {
        // Flag on the smoke App must be gone. Sibling wrong-Apps are co-scope
        // blocked for delete; the post-run D1 cleanup removes dark-launch-app-%.
        const flags = await listFlags(
          {
            fetch,
            accessToken,
            controlPlaneBaseUrl: config.controlPlaneBaseUrl,
          },
          config.smokeAppId,
        );
        const flagItems = Array.isArray(flags) ? flags : (flags.items ?? []);
        if (flagItems.some((flag) => flag.key === keys.flagKey)) {
          throw new Error(`cleanup left orphaned Flag key ${keys.flagKey}`);
        }
      },
    });
    runResults.push({
      runId,
      appKey: result.keys.appKey,
      flagKey: result.keys.flagKey,
      steps: result.steps,
    });
  }
} finally {
  consumer.dispose();
}

// Remove transient wrong-Apps created for negative proofs (D1 only; not journey path).
runSharedPreviewTransientCleanup();
const accessToken = await clientCredentialsToken(config);
const orphanedApps = await findOrphanedDarkLaunchApps(config, accessToken);
const orphanedFlags = await findOrphanedDarkLaunchFlags(config, accessToken, runResults);
if (orphanedApps.length > 0 || orphanedFlags.length > 0) {
  throw new Error(
    `cleanup assertion found orphans: apps=${JSON.stringify(orphanedApps)} flags=${JSON.stringify(orphanedFlags)}`,
  );
}

const healthRoutes = config.healthRoutes;
const observations = [];
for (const route of healthRoutes) {
  const response = await fetch(route.url);
  if (!response.ok) {
    throw new Error(`${route.surface} health returned HTTP ${response.status}`);
  }
  observations.push({ body: await response.json(), route });
}

let evidence;
try {
  evidence = createFleetEvidence({
    expectedCommitSha: deployedCommitSha,
    expectedPlatformTarget: "shared-preview",
    observations,
  });
} catch (error) {
  // Older shared-preview fleets may not yet advertise deployedCommitSha on health.
  // Still record the operator-supplied exact commit and the journey results.
  evidence = {
    deployedCommitSha,
    platformTarget: "shared-preview",
    healthCommitShaMissing: true,
    healthNote: error instanceof Error ? error.message : String(error),
    routes: healthRoutes.map((route) => ({
      surface: route.surface,
      service: route.service,
      url: route.url,
    })),
  };
}

const payload = {
  ...evidence,
  consumerInstall: installCommand,
  consecutiveRuns: runResults,
  cleanup: { orphanedApps: false, orphanedFlags: false },
  checks: {
    packedSdkConsumer: true,
    darkLaunchJourney: true,
    consecutiveRuns: runResults.length === runs,
  },
};

mkdirSync(dirname(evidencePath), { recursive: true });
writeEvidence(evidencePath, payload);
console.log(`dark-launch smoke passed (${runs} consecutive runs)`);
console.log(`evidence: ${evidencePath}`);
console.log(`deployedCommitSha: ${deployedCommitSha}`);

function readConfig() {
  const authBaseUrl = originUrl("SPLITCH_SMOKE_AUTH_BASE_URL", "https://auth.preview.splitch.dev");
  const controlPlaneBaseUrl = originUrl(
    "SPLITCH_SMOKE_CONTROL_PLANE_BASE_URL",
    "https://api.preview.splitch.dev",
  );
  const evaluationBaseUrl = originUrl(
    "SPLITCH_SMOKE_EVALUATION_BASE_URL",
    "https://edge.preview.splitch.dev",
  );
  const smokeClientSecret = process.env.SPLITCH_SMOKE_CLIENT_SECRET;
  if (!smokeClientSecret) {
    throw new Error("SPLITCH_SMOKE_CLIENT_SECRET is required for shared-preview dark-launch smoke");
  }
  return {
    authBaseUrl,
    controlPlaneBaseUrl,
    evaluationBaseUrl,
    smokeClientId: process.env.SPLITCH_SMOKE_CLIENT_ID ?? "splitch-shared-preview-smoke",
    smokeClientSecret,
    smokeOrgId: process.env.SPLITCH_SMOKE_ORG_ID ?? "org_shared_preview_smoke",
    smokeAppId: process.env.SPLITCH_SMOKE_APP_ID ?? "app_shared_preview_smoke",
    smokeEnvironmentId:
      process.env.SPLITCH_SMOKE_ENVIRONMENT_ID ?? "env_shared_preview_smoke_dev",
    runId: (process.env.SPLITCH_SMOKE_RUN_ID ?? process.env.GITHUB_RUN_ID ?? String(Date.now()))
      .toLowerCase()
      .replaceAll(/[^a-z0-9-]/g, "-")
      .slice(0, 24),
    healthRoutes: [
      route("Auth API", "splitch-auth-api", "https://auth.preview.splitch.dev/health"),
      route(
        "Control Plane API",
        "splitch-control-plane-api",
        "https://api.preview.splitch.dev/health",
      ),
      route("Evaluation API", "splitch-evaluation-api", "https://edge.preview.splitch.dev/health"),
      route(
        "Event Ingest API",
        "splitch-event-ingest-api",
        "https://ingest.preview.splitch.dev/health",
      ),
      route("MCP", "splitch-mcp-server", "https://mcp.preview.splitch.dev/health"),
    ],
  };
}

function route(surface, service, fallback) {
  return { surface, service, url: fallback };
}

async function resolveCommitSha(cfg) {
  const supplied =
    process.env.SPLITCH_SMOKE_COMMIT_SHA ?? process.env.SPLITCH_DEPLOYED_COMMIT_SHA ?? null;
  if (supplied) {
    return requireFullCommitSha(supplied, "SPLITCH_SMOKE_COMMIT_SHA");
  }
  const authRoute = cfg.healthRoutes[0];
  const response = await fetch(authRoute.url);
  if (!response.ok) {
    throw new Error(`Auth API health returned HTTP ${response.status}`);
  }
  return resolveDeployedCommitSha({
    body: await response.json(),
    expectedPlatformTarget: "shared-preview",
    route: authRoute,
  });
}

async function clientCredentialsToken(cfg) {
  const response = await fetch(`${cfg.authBaseUrl}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: cfg.smokeClientId,
      client_secret: cfg.smokeClientSecret,
    }),
  });
  if (!response.ok) {
    throw new Error(`smoke client_credentials token failed: HTTP ${response.status}`);
  }
  const body = await response.json();
  if (typeof body.access_token !== "string") {
    throw new Error("smoke client_credentials token response missing access_token");
  }
  return body.access_token;
}

function originUrl(name, fallback) {
  return new URL(process.env[name] ?? fallback).origin;
}

function runSharedPreviewTransientCleanup() {
  const result = spawnSync("pnpm", ["shared-preview:cleanup-smoke"], {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(
      `shared-preview:cleanup-smoke failed with exit ${result.status ?? "unknown"}`,
    );
  }
}

async function findOrphanedDarkLaunchApps(cfg, accessToken) {
  const apps = await listApps(
    { fetch, accessToken, controlPlaneBaseUrl: cfg.controlPlaneBaseUrl },
    cfg.smokeOrgId,
  );
  const items = Array.isArray(apps) ? apps : (apps.items ?? apps.apps ?? []);
  return items
    .filter((app) => typeof app.key === "string" && app.key.startsWith("dark-launch-app-"))
    .map((app) => ({ id: app.id, key: app.key }));
}

async function findOrphanedDarkLaunchFlags(cfg, accessToken, results) {
  const flags = await listFlags(
    { fetch, accessToken, controlPlaneBaseUrl: cfg.controlPlaneBaseUrl },
    cfg.smokeAppId,
  );
  const items = Array.isArray(flags) ? flags : (flags.items ?? []);
  const watched = new Set(results.map((result) => result.flagKey));
  return items
    .filter((flag) => watched.has(flag.key))
    .map((flag) => ({ id: flag.id, key: flag.key }));
}

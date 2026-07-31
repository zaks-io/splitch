#!/usr/bin/env node
/**
 * Shared-preview hosted onboarding proof (SPL-148).
 *
 * Runs the external-product dark-launch journey twice consecutively against the
 * pre-authorized shared-preview smoke identity through OAuth PRM and exact-resource
 * MCP tokens. Each run owns a transient App and uses only product surfaces.
 *
 * Required env:
 *   SPLITCH_SMOKE_CLIENT_SECRET
 *   SPLITCH_SMOKE_COMMIT_SHA or SPLITCH_DEPLOYED_COMMIT_SHA (must match health)
 * Optional:
 *   SPLITCH_SMOKE_RUNS (default 2)
 *   SPLITCH_DARK_LAUNCH_EVIDENCE (evidence output path)
 */
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createFleetEvidence,
  requireFullCommitSha,
} from "../lib/shared-preview-deployment-evidence.mjs";
import { SMOKE_IDS } from "../seed-shared-preview-smoke-sql.mjs";
import { throwPrimaryWithCleanup } from "./cleanup-failures.mjs";
import {
  assertRevokedCredential,
  cleanupDeferredRuns,
  findOrphanedDarkLaunchApps,
  RESULT_REREAD_DELAY_MS,
} from "./hosted-cleanup.mjs";
import {
  assertExposureHealth,
  assertToolParity,
  pollResults,
  summarizeExposureHealth,
} from "./hosted-results.mjs";
import { PROPAGATION_WINDOW_MS, runDarkLaunchJourney } from "./journey.mjs";
import { createMcpClient } from "./mcp-client.mjs";
import { installPackedSdkConsumer, runExternalResolve, writeEvidence } from "./pack-consumer.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const runs = Math.max(1, Number(process.env.SPLITCH_SMOKE_RUNS ?? "2"));
const evidencePath =
  process.env.SPLITCH_DARK_LAUNCH_EVIDENCE ??
  resolve(repoRoot, "test-results/shared-preview/dark-launch-evidence.json");

const config = readConfig();
const expectedCommitSha = requireFullCommitSha(
  process.env.SPLITCH_SMOKE_COMMIT_SHA ?? process.env.SPLITCH_DEPLOYED_COMMIT_SHA,
  "SPLITCH_SMOKE_COMMIT_SHA",
);
const consumer = installPackedSdkConsumer();
const installCommand = consumer.installCommand.replace(
  consumer.tarballPath,
  "<packed-tarball.tgz>",
);

const runResults = [];
let cleanupResults = [];
const mcp = await createMcpClient(config);
const tools = await mcp.listTools();
const toolParity = assertToolParity(tools);
const organizations = await mcp.callTool("organizations_list", {});
const organizationItems = Array.isArray(organizations)
  ? organizations
  : (organizations.items ?? []);
if (!organizationItems.some((organization) => organization.id === config.smokeOrgId)) {
  throw new Error("organizations_list did not discover the seeded smoke Organization");
}
let journeyFailure;
try {
  for (let index = 0; index < runs; index += 1) {
    const runId = `${config.runId}-r${index + 1}`;
    let observedResults;
    const result = await runDarkLaunchJourney({
      fetch,
      orgId: config.smokeOrgId,
      controlPlaneBaseUrl: config.controlPlaneBaseUrl,
      evaluationBaseUrl: config.evaluationBaseUrl,
      foreignOrgId: config.foreignOrgId,
      runId,
      propagationWindowMs: PROPAGATION_WINDOW_MS,
      cleanupStabilityWindowMs: RESULT_REREAD_DELAY_MS,
      deferCleanup: true,
      callTool: mcp.callTool,
      callToolResult: mcp.callToolResult,
      resolve: (action, options) => runExternalResolve(consumer, action, options),
      assertCredentialRevoked: ({ clientKey, flagKey }) =>
        assertRevokedCredential(consumer, config.evaluationBaseUrl, clientKey, flagKey),
      assertVerifyClean: async ({ appId, environmentId, experimentId, runId: liveRunId }) => {
        const results = await pollResults(mcp, {
          appId,
          environmentId,
          experimentId,
          runId: liveRunId,
        });
        assertExposureHealth(results, 0);
      },
      assertEvaluateObservation: async ({
        appId,
        environmentId,
        first,
        retry,
        experimentId,
        runId: liveRunId,
      }) => {
        if (first.reason === "ERROR" || retry.reason === "ERROR") {
          throw new Error("evaluate observation failed loud");
        }
        if (first.value !== retry.value) {
          throw new Error("retry-safe evaluate returned a different Variant");
        }
        const results = await pollResults(
          mcp,
          {
            appId,
            environmentId,
            experimentId,
            runId: liveRunId,
          },
          1,
        );
        assertExposureHealth(results, 1);
        observedResults = results;
      },
    });
    runResults.push({
      runId,
      appKey: result.keys.appKey,
      flagKey: result.keys.flagKey,
      experimentKey: result.keys.experimentKey,
      exposureHealth: summarizeExposureHealth(observedResults),
      negativeProofs: result.negativeProofs,
      resultScope: {
        appId: result.resources.appId,
        environmentId: result.resources.environmentId,
        experimentId: result.resources.experimentId,
        runId: result.resources.runId,
      },
      cleanup: result.cleanup,
      steps: result.steps,
    });
  }

  for (const run of runResults) {
    const finalResults = await pollResults(mcp, run.resultScope, 1);
    assertExposureHealth(finalResults, 1);
    run.exposureHealth = summarizeExposureHealth(finalResults);
  }
} catch (error) {
  journeyFailure = error;
}

let cleanupFailure;
try {
  cleanupResults = await cleanupDeferredRuns(runResults);
} catch (error) {
  cleanupFailure = error;
}
consumer.dispose();
throwPrimaryWithCleanup(
  journeyFailure,
  cleanupFailure ? [cleanupFailure] : [],
  "hosted onboarding journey failed and cleanup also failed",
);

const orphanScans = await findOrphanedDarkLaunchApps(config, mcp);
const orphanedApps = orphanScans.flat();

const healthRoutes = config.healthRoutes;
const observations = [];
for (const route of healthRoutes) {
  const response = await fetch(route.url);
  if (!response.ok) {
    throw new Error(`${route.surface} health returned HTTP ${response.status}`);
  }
  observations.push({ body: await response.json(), route });
}

const evidence = createFleetEvidence({
  expectedCommitSha,
  expectedPlatformTarget: "shared-preview",
  observations,
});

const payload = {
  ...evidence,
  consumerInstall: installCommand,
  consecutiveRuns: runResults.map(({ cleanup: _cleanup, resultScope: _scope, ...run }) => run),
  cleanup: {
    orphanedApps,
    orphanedFlags: cleanupResults.some((result) => !result.flagDeleted),
    orphanedCredentials: cleanupResults.some((result) => !result.credentialRevoked),
    transientAppsDeleted:
      cleanupResults.length === runs && cleanupResults.every((result) => result.appDeleted),
    observations: { cleanupResults, orphanScans },
  },
  checks: {
    packedSdkConsumer: consumer.installCommand.length > 0,
    oauthPrmDiscovery:
      mcp.discovery.challengeStatus === 401 &&
      mcp.discovery.protectedResourceUrl.endsWith("/.well-known/oauth-protected-resource/mcp"),
    exactResourceMcpToken:
      mcp.discovery.exactResourceTokenGranted &&
      mcp.discovery.resource === `${config.mcpBaseUrl}/mcp`,
    mcpOnboardingTools: toolParity.missing.length === 0,
    firstExposure: runResults.every(
      (run) =>
        run.exposureHealth.exposureTotal === 1 &&
        run.exposureHealth.dedupedTotal === 1 &&
        run.exposureHealth.multipleCount === 0,
    ),
    negativeAuthorization: runResults.every(
      (run) =>
        run.negativeProofs.wrongApp.isolated &&
        run.negativeProofs.wrongApp.scopedMissErrorCode === "FLAG_NOT_FOUND" &&
        run.negativeProofs.revokedCredential.errorCode === "CREDENTIAL_REVOKED" &&
        run.negativeProofs.crossOrganization.writeCode === "FORBIDDEN" &&
        run.negativeProofs.crossOrganization.listCode === "FORBIDDEN",
    ),
    consecutiveRuns:
      runResults.length === runs && new Set(runResults.map((run) => run.runId)).size === runs,
  },
  oauth: mcp.discovery,
  toolParity,
};

mkdirSync(dirname(evidencePath), { recursive: true });
writeEvidence(evidencePath, payload);
if (orphanedApps.length > 0) {
  throw new Error(`cleanup assertion found orphaned Apps: ${JSON.stringify(orphanedApps)}`);
}
console.log(`dark-launch smoke passed (${runs} consecutive runs)`);
console.log(`evidence: ${evidencePath}`);
console.log(`deployedCommitSha: ${evidence.deployedCommitSha}`);

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
    mcpBaseUrl: originUrl("SPLITCH_SMOKE_MCP_BASE_URL", "https://mcp.preview.splitch.dev"),
    smokeClientId: process.env.SPLITCH_SMOKE_CLIENT_ID ?? "splitch-shared-preview-smoke",
    smokeClientSecret,
    smokeOrgId: process.env.SPLITCH_SMOKE_ORG_ID ?? "org_shared_preview_smoke",
    // The smoke identity cannot discover Organizations outside its membership.
    // This hosted negative therefore proves exact-resource OAuth scope refusal;
    // the seeded SQL proves existence and the local journey proves the DB-backed
    // membership guard against a directly observed foreign Organization.
    foreignOrgId: SMOKE_IDS.isolationOrg,
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

function originUrl(name, fallback) {
  return new URL(process.env[name] ?? fallback).origin;
}

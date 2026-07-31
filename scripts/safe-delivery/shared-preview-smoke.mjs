#!/usr/bin/env node
/**
 * Shared-preview safe-delivery tracer (SPL-151).
 *
 * Proves the full safe Flag delivery loop against shared preview: tune in the
 * logical `dev` Environment, Promote selected field groups into the logical
 * `prod` Environment through the confirm gate, observe the changed resolution,
 * prove the Worker's refusals, and kill the Flag.
 *
 * `dev` and `prod` are logical Environments on the seeded shared-preview smoke
 * App. No hosted production resource or deployment is touched.
 *
 * Required env:
 *   SPLITCH_SMOKE_CLIENT_SECRET   OAuth2 client secret for the smoke identity
 *   SPLITCH_SMOKE_COMMIT_SHA      full 40-char deployed commit SHA
 *                                 (or SPLITCH_DEPLOYED_COMMIT_SHA)
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import { createFleetEvidence } from "../lib/shared-preview-deployment-evidence.mjs";
import { sweepOrphanedSafeDeliveryFlags } from "./cleanup.mjs";
import { readConfig } from "./config.mjs";
import { runSafeDeliveryJourney } from "./journey.mjs";

const repoRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), "..", "..");

const config = readConfig(process.env);
const runs = config.runs;
const evidencePath = resolvePath(repoRoot, config.evidencePath);

const runResults = [];
for (let index = 0; index < runs; index += 1) {
  const accessToken = await mintAccessToken(config);
  const runId = `${config.runId}-r${index + 1}`;
  const deps = journeyDeps(config, accessToken, runId);
  const result = await runSafeDeliveryJourney(deps);
  runResults.push({
    runId,
    primaryFlagKey: result.keys.primaryFlagKey,
    steps: result.steps,
    evidence: result.evidence,
  });
}

const sweepToken = await mintAccessToken(config);
const swept = await sweepOrphanedSafeDeliveryFlags(
  journeyDeps(config, sweepToken, `${config.runId}-sweep`),
  config.appId,
);
if (swept.length > 0) {
  throw new Error(`safe-delivery sweep found orphaned Flags after cleanup: ${swept.join(", ")}`);
}

const observations = [];
for (const route of healthRoutes(config)) {
  const response = await fetch(route.url);
  if (!response.ok) {
    throw new Error(`${route.surface} health returned HTTP ${response.status}`);
  }
  observations.push({ body: await response.json(), route });
}
const evidence = createFleetEvidence({
  expectedCommitSha: config.commitSha,
  expectedPlatformTarget: "shared-preview",
  observations,
});

const payload = {
  ...evidence,
  consecutiveRuns: runResults,
  cleanup: { orphanedFlags: false, sweptFlags: swept },
  checks: {
    safeDeliveryJourney: true,
    consecutiveRuns: runResults.length === runs,
  },
};
mkdirSync(dirname(evidencePath), { recursive: true });
writeFileSync(evidencePath, `${JSON.stringify(payload, null, 2)}\n`);

console.log(`safe-delivery tracer passed (${runs} consecutive runs)`);
console.log(`evidence: ${evidencePath}`);
console.log(`deployedCommitSha: ${evidence.deployedCommitSha}`);

function journeyDeps(cfg, accessToken, runId) {
  return {
    fetch,
    accessToken,
    runId,
    controlPlaneBaseUrl: cfg.controlPlaneBaseUrl,
    evaluationBaseUrl: cfg.evaluationBaseUrl,
    appId: cfg.appId,
    devEnvironmentId: cfg.devEnvironmentId,
    prodEnvironmentId: cfg.prodEnvironmentId,
    otherAppEnvironmentId: cfg.otherAppEnvironmentId,
    devClientKey: cfg.devClientKey,
    prodClientKey: cfg.prodClientKey,
    stableFlagKey: cfg.stableFlagKey,
    propagationWindowMs: cfg.propagationWindowMs,
  };
}

async function mintAccessToken(cfg) {
  const response = await fetch(`${cfg.authBaseUrl}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
    }),
  });
  if (!response.ok) {
    throw new Error(`oauth2 token request failed with HTTP ${response.status}`);
  }
  const body = await response.json();
  if (typeof body.access_token !== "string" || body.access_token.length === 0) {
    throw new Error("oauth2 token response omitted access_token");
  }
  return body.access_token;
}

function healthRoutes(cfg) {
  return [
    { surface: "auth", service: "splitch-auth-api", url: `${cfg.authBaseUrl}/` },
    {
      surface: "control-plane",
      service: "splitch-control-plane-api",
      url: `${cfg.controlPlaneBaseUrl}/`,
    },
    {
      surface: "evaluation",
      service: "splitch-evaluation-api",
      url: `${cfg.evaluationBaseUrl}/`,
    },
  ];
}

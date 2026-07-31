#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { requireFullCommitSha } from "./lib/shared-preview-deployment-evidence.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const mode = process.argv[2];
if (mode !== "reset" && mode !== "smoke") {
  fail("usage: render-shared-preview-summary.mjs <reset|smoke>");
}

try {
  process.stdout.write(renderSummary(summaryInput(mode)));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

export function renderSummary(input) {
  const lines = [`## Shared preview ${input.mode}`, "", `- Workflow ref: \`${input.ref}\``];
  if (input.mode === "reset") {
    lines.push(`- Reset outcome: \`${input.resetOutcome}\``);
    lines.push(`- Smoke outcome: \`${input.smokeOutcome}\``);
  } else {
    lines.push(`- Seed outcome: \`${input.seedOutcome}\``);
    lines.push(`- Smoke outcome: \`${input.smokeOutcome}\``);
    lines.push(`- Dark-launch outcome: \`${input.darkLaunchOutcome}\``);
  }
  lines.push(`- Cleanup outcome: \`${input.cleanupOutcome}\``);
  if (input.mode === "smoke") {
    lines.push(`- Failure artifact outcome: \`${input.artifactOutcome}\``);
  }

  if (input.evidence) {
    lines.push(
      "",
      "### Verified smoke evidence",
      "",
      `- platformTarget: \`${input.evidence.platformTarget}\``,
      `- Deployed commit SHA: \`${input.evidence.deployedCommitSha}\``,
      `- Tinybird Branch: \`${input.tinybirdBranch}\``,
      "- Exercised health routes:",
      ...input.evidence.routes.map((route) => `  - ${route.surface}: ${route.url}`),
      "- Exercised functional routes: Auth discovery, device authorization, JWKS, client credentials, Control Plane reads, MCP tools/list, and MCP tools/call",
      "- Applied D1 migrations:",
      ...input.migrations.map((migration) => `  - \`${migration}\``),
    );
  }
  return `${lines.join("\n")}\n`;
}

function summaryInput(summaryMode) {
  const ref = requireFullCommitSha(
    process.env.SPLITCH_WORKFLOW_REF ?? process.env.SPLITCH_DEPLOYED_COMMIT_SHA,
    "workflow ref",
  );
  const smokeOutcome = process.env.SPLITCH_SMOKE_OUTCOME ?? "unknown";
  const evidence = smokeOutcome === "success" ? readEvidence() : undefined;
  if (summaryMode === "smoke" && evidence && evidence.deployedCommitSha !== ref) {
    throw new Error(
      `deployed commit ${evidence.deployedCommitSha} differs from deploy workflow ref ${ref}`,
    );
  }
  return {
    mode: summaryMode,
    ref,
    resetOutcome: process.env.SPLITCH_RESET_OUTCOME ?? "unknown",
    seedOutcome: process.env.SPLITCH_SEED_OUTCOME ?? "unknown",
    smokeOutcome,
    darkLaunchOutcome: process.env.SPLITCH_DARK_LAUNCH_OUTCOME ?? "unknown",
    cleanupOutcome: process.env.SPLITCH_CLEANUP_OUTCOME ?? "unknown",
    artifactOutcome: process.env.SPLITCH_ARTIFACT_OUTCOME ?? "unknown",
    evidence,
    tinybirdBranch: "shared_preview",
    migrations: migrationNames(),
  };
}

function readEvidence() {
  const path = resolve(
    process.env.SPLITCH_SMOKE_EVIDENCE_FILE ??
      resolve(repoRoot, "test-results/shared-preview/deployment-evidence.json"),
  );
  const evidence = JSON.parse(readFileSync(path, "utf8"));
  requireFullCommitSha(evidence.deployedCommitSha, "verified deployed commit SHA");
  if (evidence.platformTarget !== "shared-preview") {
    throw new Error(`smoke evidence has platformTarget ${String(evidence.platformTarget)}`);
  }
  if (!Array.isArray(evidence.routes) || evidence.routes.length === 0) {
    throw new Error("smoke evidence contains no exercised routes");
  }
  return evidence;
}

function migrationNames() {
  const directory = resolve(repoRoot, "packages/db/migrations");
  return readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => basename(name));
}

function fail(message) {
  console.error(`shared-preview-summary: ${message}`);
  process.exit(1);
}

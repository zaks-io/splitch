#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { requireFullCommitSha } from "./lib/shared-preview-deployment-evidence.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const mode = process.argv[2];
if (mode !== "deploy" && mode !== "reset" && mode !== "smoke") {
  fail("usage: render-shared-preview-summary.mjs <deploy|reset|smoke>");
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
  } else if (input.mode === "deploy") {
    lines.push(`- Deploy outcome: \`${input.deployOutcome}\``);
    lines.push(`- Smoke workflow dispatch outcome: \`${input.smokeDispatchOutcome}\``);
  } else {
    lines.push(`- Smoke outcome: \`${input.smokeOutcome}\``);
    lines.push(`- Dark-launch outcome: \`${input.darkLaunchOutcome}\``);
  }
  if (input.mode !== "deploy") {
    lines.push(`- Cleanup outcome: \`${input.cleanupOutcome}\``);
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
  const evidence = smokeEvidence(summaryMode, smokeOutcome);
  if (summaryMode === "smoke" && evidence && evidence.deployedCommitSha !== ref) {
    throw new Error(
      `deployed commit ${evidence.deployedCommitSha} differs from deploy workflow ref ${ref}`,
    );
  }
  return {
    mode: summaryMode,
    ref,
    deployOutcome: process.env.SPLITCH_DEPLOY_OUTCOME ?? "unknown",
    smokeDispatchOutcome: process.env.SPLITCH_SMOKE_DISPATCH_OUTCOME ?? "unknown",
    resetOutcome: process.env.SPLITCH_RESET_OUTCOME ?? "unknown",
    smokeOutcome,
    darkLaunchOutcome: process.env.SPLITCH_DARK_LAUNCH_OUTCOME ?? "unknown",
    cleanupOutcome: process.env.SPLITCH_CLEANUP_OUTCOME ?? "unknown",
    evidence,
    tinybirdBranch: "shared_preview",
    migrations: migrationNames(),
  };
}

function smokeEvidence(summaryMode, smokeOutcome) {
  if (summaryMode === "deploy" || smokeOutcome !== "success") return undefined;
  return readEvidence();
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

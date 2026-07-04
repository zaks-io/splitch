#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createProbePlan } from "./shared-preview-smoke/probes.mjs";

const expectedPlatformTarget = "shared-preview";
const tinybirdBranch = "shared_preview";
const requestTimeoutMs = positiveInt(process.env.SPLITCH_SMOKE_REQUEST_TIMEOUT_MS, 5000);
const retryDelayMs = positiveInt(process.env.SPLITCH_SMOKE_RETRY_DELAY_MS, 5000);
const timeoutMs = positiveInt(process.env.SPLITCH_SMOKE_TIMEOUT_MS, 120000);
const commitSha = process.env.SPLITCH_SMOKE_COMMIT_SHA ?? currentGitSha();
const routes = [
  ["Marketing", "splitch-marketing", "MARKETING", "preview.splitch.dev"],
  ["Control Panel", "splitch-control-panel", "CONTROL_PANEL", "app.preview.splitch.dev"],
  [
    "Control Plane API",
    "splitch-control-plane-api",
    "CONTROL_PLANE_API",
    "api.preview.splitch.dev",
  ],
  ["Auth API", "splitch-auth-api", "AUTH_API", "auth.preview.splitch.dev"],
  ["Evaluation API", "splitch-evaluation-api", "EVALUATION_API", "edge.preview.splitch.dev"],
  [
    "Event Ingest API",
    "splitch-event-ingest-api",
    "EVENT_INGEST_API",
    "ingest.preview.splitch.dev",
  ],
  ["MCP", "splitch-mcp-server", "MCP", "mcp.preview.splitch.dev"],
].map(([surface, service, envSuffix, host]) => ({
  surface,
  service,
  url: envUrl(`SPLITCH_SMOKE_${envSuffix}_URL`, `https://${host}/health`),
}));

const authBaseUrl = originUrl("SPLITCH_SMOKE_AUTH_BASE_URL", "https://auth.preview.splitch.dev");
const mcpBaseUrl = originUrl("SPLITCH_SMOKE_MCP_BASE_URL", "https://mcp.preview.splitch.dev");
const { unauthenticatedProbes, smokeAuthProbe, authenticatedProbes } = createProbePlan({
  expectedPlatformTarget,
  requestTimeoutMs,
  routes,
  authBaseUrl,
  mcpBaseUrl,
  smokeClientId: process.env.SPLITCH_SMOKE_CLIENT_ID ?? "splitch-shared-preview-smoke",
  smokeClientSecret: process.env.SPLITCH_SMOKE_CLIENT_SECRET,
  smokeAppId: process.env.SPLITCH_SMOKE_APP_ID ?? "smoke-auth-missing-app",
});

const unauthenticatedResults = await Promise.all(unauthenticatedProbes.map(runProbe));
const smokeAuthResult = await runProbe(smokeAuthProbe);
const authenticatedResults = smokeAuthResult.ok
  ? await Promise.all(authenticatedProbes.map(runProbe))
  : [];
const results = [...unauthenticatedResults, smokeAuthResult, ...authenticatedResults];
const migrations = await migrationNames();
const markdown = smokeMarkdown({ results, migrations });
await writeSummary(markdown);

for (const result of results) {
  const status = result.ok ? "ok" : "fail";
  console.log(`shared-preview:smoke: ${status} ${result.name} ${result.url} ${result.detail}`);
}

const failures = results.filter((result) => !result.ok);
if (failures.length > 0) {
  console.error(`shared-preview:smoke: ${failures.length} check(s) failed`);
  process.exit(1);
}

console.log(`shared-preview:smoke: ok ${results.length} checks passed`);

async function runProbe(probe) {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  let lastError;

  while (Date.now() <= deadline) {
    attempts += 1;
    try {
      const detail = await probe.run();
      return { ok: true, name: probe.name, url: probe.url, detail, attempts };
    } catch (error) {
      lastError = error;
      if (Date.now() + retryDelayMs > deadline) {
        break;
      }
      await delay(retryDelayMs);
    }
  }

  return {
    ok: false,
    name: probe.name,
    url: probe.url,
    detail: lastError instanceof Error ? lastError.message : String(lastError),
    attempts,
  };
}

async function migrationNames() {
  const entries = await readdir(join(process.cwd(), "packages/db/migrations")).catch(() => []);
  return entries.filter((entry) => entry.endsWith(".sql")).sort();
}

async function writeSummary(markdown) {
  if (process.env.SPLITCH_SMOKE_SUMMARY_PATH) {
    await writeFile(process.env.SPLITCH_SMOKE_SUMMARY_PATH, markdown);
  }
}

function smokeMarkdown({ results, migrations }) {
  const lines = [
    "## Shared preview smoke",
    "",
    `- Platform target: \`${expectedPlatformTarget}\``,
    `- Commit: \`${commitSha}\``,
    `- Tinybird Branch: \`${tinybirdBranch}\``,
    `- D1 migration set: ${migrations.length > 0 ? migrations.map((name) => `\`${name}\``).join(", ") : "_none found_"}`,
    `- Routes exercised: ${[...new Set(results.map((result) => result.url))]
      .sort()
      .map((url) => `<${url}>`)
      .join(", ")}`,
    "",
    "| Check | URL | Result | Attempts | Detail |",
    "| --- | --- | --- | ---: | --- |",
    ...results.map(
      (result) =>
        `| ${escapeMarkdown(result.name)} | <${result.url}> | ${result.ok ? "pass" : "fail"} | ${result.attempts} | ${escapeMarkdown(result.detail)} |`,
    ),
    "",
  ];
  return `${lines.join("\n")}\n`;
}

function currentGitSha() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : "unknown";
}

function envUrl(name, fallback) {
  const value = process.env[name] ?? fallback;
  return new URL(value).toString();
}

function originUrl(name, fallback) {
  const url = new URL(process.env[name] ?? fallback);
  return url.origin;
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function escapeMarkdown(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

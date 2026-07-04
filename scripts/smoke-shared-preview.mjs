#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

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
const probes = [
  ...routes.map((route) => ({
    name: `${route.surface} health`,
    url: route.url,
    run: () => assertHealth(route),
  })),
  {
    name: "Auth OAuth discovery",
    url: `${authBaseUrl}/.well-known/oauth-authorization-server`,
    run: assertAuthDiscovery,
  },
  {
    name: "Auth WorkOS device authorization",
    url: `${authBaseUrl}/oauth2/device_authorization`,
    run: assertDeviceAuthorization,
  },
  {
    name: "MCP tools/list",
    url: `${mcpBaseUrl}/mcp`,
    run: assertMcpToolsList,
  },
  {
    name: "MCP Analysis binding",
    url: `${mcpBaseUrl}/mcp`,
    run: assertMcpAnalysisBinding,
  },
];

const results = await Promise.all(probes.map(runProbe));
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

async function assertHealth(route) {
  const response = await fetchWithTimeout(route.url);
  assertStatus(response, 200);
  const body = await response.json();
  assertEqual(body.ok, true, "ok");
  assertEqual(body.service, route.service, "service");
  assertEqual(body.platformTarget, expectedPlatformTarget, "platformTarget");
  return `${route.service} ${body.platformTarget}`;
}

async function assertAuthDiscovery() {
  const url = `${authBaseUrl}/.well-known/oauth-authorization-server`;
  const response = await fetchWithTimeout(url);
  assertStatus(response, 200);
  const body = await response.json();
  assertEqual(body.issuer, authBaseUrl, "issuer");
  assertEqual(body.token_endpoint, `${authBaseUrl}/oauth2/token`, "token_endpoint");
  assertEqual(
    body.device_authorization_endpoint,
    `${authBaseUrl}/oauth2/device_authorization`,
    "device_authorization_endpoint",
  );
  if (!body.agent_auth?.identity_types_supported?.includes("device_flow")) {
    throw new Error("agent_auth.identity_types_supported did not include device_flow");
  }
  return "oauth metadata includes device_flow";
}

async function assertDeviceAuthorization() {
  const response = await fetchWithTimeout(`${authBaseUrl}/oauth2/device_authorization`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(),
  });
  assertStatus(response, 200);
  const body = await response.json();
  const missingField = ["device_code", "user_code", "verification_uri", "expires_in"].find(
    (field) => body[field] === undefined || body[field] === null || body[field] === "",
  );
  if (missingField) {
    throw new Error(`device authorization response missing ${missingField}`);
  }
  if (typeof body.verification_uri !== "string" || !body.verification_uri.startsWith("https://")) {
    throw new Error("device authorization verification_uri was not https");
  }
  if (body.verification_uri.includes(".test")) {
    throw new Error("device authorization used fixture WorkOS provider");
  }
  if (typeof body.expires_in !== "number" || body.expires_in <= 0) {
    throw new Error("device authorization expires_in was not positive");
  }
  return `verification_uri=${body.verification_uri}`;
}

async function assertMcpToolsList() {
  const body = await mcpRequest({
    jsonrpc: "2.0",
    id: "tools-list-smoke",
    method: "tools/list",
  });
  const tools = body.result?.tools;
  if (!Array.isArray(tools) || tools.length === 0) {
    throw new Error("MCP tools/list returned no tools");
  }
  if (!tools.some((tool) => tool?.name === "experiment_results_get")) {
    throw new Error("MCP tools/list did not include experiment_results_get");
  }
  return `${tools.length} tools`;
}

async function assertMcpAnalysisBinding() {
  const body = await mcpRequest({
    jsonrpc: "2.0",
    id: "analysis-binding-smoke",
    method: "tools/call",
    params: {
      name: "experiment_results_get",
      arguments: {
        appId: "smoke-app",
        environmentId: "smoke-env",
        experimentId: "smoke-exp",
      },
    },
  });
  if (body.error) {
    throw new Error(`MCP returned ${body.error.code}: ${body.error.message}`);
  }
  const structured = body.result?.structuredContent;
  if (body.result?.isError !== true || structured?.code !== "UNAUTHORIZED") {
    throw new Error("MCP analysis binding did not return expected UNAUTHORIZED tool result");
  }
  return "analysis service binding returned UNAUTHORIZED as expected";
}

async function mcpRequest(body) {
  const response = await fetchWithTimeout(`${mcpBaseUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assertStatus(response, 200);
  return response.json();
}

async function fetchWithTimeout(url, init = {}) {
  return fetch(url, {
    ...init,
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
}

function assertStatus(response, expected) {
  if (response.status !== expected) {
    throw new Error(`expected HTTP ${expected}, got ${response.status}`);
  }
}

function assertEqual(actual, expected, name) {
  if (actual !== expected) {
    throw new Error(`expected ${name} ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
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

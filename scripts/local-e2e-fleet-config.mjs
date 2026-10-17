import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const wranglerManifest = createRequire(import.meta.url).resolve("wrangler/package.json");

// Run with `process.execPath` rather than through `pnpm exec`, whose wrapper
// process stays resident for the life of each Worker at ~100 MiB apiece.
export const wranglerBin = resolve(
  dirname(wranglerManifest),
  JSON.parse(readFileSync(wranglerManifest, "utf8")).bin.wrangler,
);

export const localBindings = {
  CONTROL_PANEL_DELEGATION_SECRET: "local-control-panel-delegation-secret",
  SENTRY_DSN: "",
  SPLITCH_PLATFORM_TARGET: "local",
  TINYBIRD_APPROVAL_ARCHIVE_WRITE_TOKEN: "local-e2e-tinybird-read-token",
  TINYBIRD_APPROVAL_ARCHIVE_READ_TOKEN: "local-e2e-tinybird-read-token",
  TINYBIRD_RUN_SNAPSHOT_TOKEN: "local-e2e-tinybird-read-token",
  TINYBIRD_READ_TOKEN: "local-e2e-tinybird-read-token",
  TINYBIRD_COPY_TOKEN: "local-e2e-tinybird-copy-token",
  TINYBIRD_DELETE_TOKEN: "local-e2e-tinybird-delete-token",
  TINYBIRD_INGEST_TOKEN: "local-e2e-tinybird-read-token",
  SPLITCH_EVENT_INGEST_TOKEN: "local-e2e-event-ingest-token",
  WORKOS_API_KEY: "local-e2e-workos-api-key",
  WORKOS_CLIENT_ID: "local-e2e-workos-client-id",
};

export function localE2eWorkers(persistPath, { full = false } = {}) {
  const workers = [
    {
      name: "analysis-source",
      origin: "http://127.0.0.1:18788",
      command: "node",
      args: ["scripts/local-e2e-analysis-source.mjs"],
    },
    {
      name: "analysis-api",
      origin: "http://127.0.0.1:8790",
      command: process.execPath,
      args: [
        wranglerBin,
        "dev",
        "--config",
        "apps/analysis-api/wrangler.jsonc",
        "--local",
        "--ip",
        "127.0.0.1",
        "--port",
        "8790",
        "--inspector-port",
        "0",
        "--persist-to",
        persistPath,
        "--var",
        "TINYBIRD_API_URL:http://127.0.0.1:18788",
        "--var",
        "TINYBIRD_READ_TOKEN:local-e2e-tinybird-read-token",
        "--var",
        "TINYBIRD_COPY_TOKEN:local-e2e-tinybird-copy-token",
        "--var",
        "SENTRY_DSN:",
      ],
      checkRunId: false,
      env: {
        TINYBIRD_READ_TOKEN: "local-e2e-tinybird-read-token",
        TINYBIRD_COPY_TOKEN: "local-e2e-tinybird-copy-token",
      },
    },
    {
      name: "control-plane-api",
      origin: "http://127.0.0.1:18790",
      command: process.execPath,
      args: [
        wranglerBin,
        "dev",
        "--config",
        "apps/control-plane-api/wrangler.jsonc",
        "--local",
        "--ip",
        "127.0.0.1",
        "--port",
        "18790",
        "--inspector-port",
        "0",
        "--persist-to",
        persistPath,
        // The token minted by analysis-source is issued by 18788 FOR this origin,
        // and this is the Worker that verifies it: operator-addressed reads land
        // here even when the Analysis Worker executes them (ADR-0046). Without a
        // reachable JWKS the verify step fails at the socket, which the registrar
        // turns into a 500 on a route that should have answered.
        //
        // These are exactly what `ControlPlaneApiEnv` declares and what the
        // hosted wrangler.jsonc sets, so the fleet cannot drift from production
        // by carrying a var this Worker never reads.
        "--var",
        "AUTH_JWKS_URI:http://127.0.0.1:18788/.well-known/jwks.json",
        "--var",
        "CONTROL_PLANE_ORIGIN:http://127.0.0.1:18790",
      ],
    },
    {
      name: "control-panel",
      origin: "http://127.0.0.1:18793",
      command: process.execPath,
      args: [
        resolve(repoRoot, "scripts/vite-dev.mjs"),
        "dev",
        "--host",
        "127.0.0.1",
        "--port",
        "18793",
      ],
      cwd: resolve(repoRoot, "apps/control-panel"),
      env: {
        ...localBindings,
        SPLITCH_LOCAL_E2E_PERSIST_PATH: persistPath,
      },
    },
  ];
  return full
    ? workers.filter((worker) => ["analysis-source", "control-panel"].includes(worker.name))
    : workers;
}

const { parseConfigFileTextToJson } = createRequire(import.meta.url)("typescript");
export const apiWorkers = [
  "control-plane-api",
  "analysis-api",
  "evaluation-api",
  "event-ingest-api",
  "auth-api",
  "mcp-server",
];
const namespaces = {
  SESSION_STORE: "local-session-store",
  CONFIG_STORE: "local-config-store",
  CREDENTIAL_STORE: "local-credential-store",
  JTI_CACHE: "local-jti-cache",
};

export async function createApiFleetConfigs(context) {
  const { workers = apiWorkers } = context;
  const configs = [];
  for (const worker of workers) configs.push(await workerConfig(worker, context));
  return [await gatewayConfig({ ...context, workers }), ...configs];
}
async function workerConfig(worker, context) {
  const { agent, origin, issuerOrigin, privateKey } = context;
  const path = resolve(repoRoot, "apps", worker, "wrangler.jsonc");
  const parsed = parseConfigFileTextToJson(path, await readFile(path, "utf8"));
  if (parsed.error) throw new Error("Worker JSONC configuration failed to parse");
  const { env: _env, $schema: _schema, secrets: _secrets, ...config } = parsed.config;
  config.name += `-${agent}`;
  config.main = resolve(dirname(path), config.main);
  config.vars = {
    ...config.vars,
    ...localBindings,
    SPLITCH_LOCAL_E2E_RUN_ID: agent,
    TINYBIRD_API_URL: issuerOrigin,
    AUTH_JWKS_URI: `${issuerOrigin}/.well-known/jwks.json`,
    CONTROL_PLANE_ORIGIN: origin,
    CONTROL_PLANE_API_ORIGIN: origin,
    AUTH_API_ORIGIN: `http://localhost:${new URL(origin).port}`,
    MCP_ORIGIN: origin,
    ACCESS_TOKEN_SECRET: JSON.stringify(privateKey.export({ format: "jwk" })),
  };
  config.kv_namespaces = config.kv_namespaces?.map((binding) => ({
    ...binding,
    id: namespaces[binding.binding] ?? binding.id,
    preview_id: namespaces[binding.binding] ?? binding.id,
  }));
  config.services = config.services?.map((binding) => ({
    ...binding,
    service: `${binding.service}-${agent}`,
  }));
  if (config.durable_objects)
    config.durable_objects.bindings = config.durable_objects.bindings.map((binding) => ({
      ...binding,
      ...(binding.script_name ? { script_name: `${binding.script_name}-${agent}` } : {}),
    }));
  if (worker === "control-plane-api") {
    config.ratelimits = [
      {
        name: "CONTROL_PLANE_ACTOR_RATE_LIMITER",
        namespace_id: "1102",
        simple: { limit: 600, period: 60 },
      },
    ];
    if (context.teardown) config.main = await scheduledEntry(config.main, context);
  }
  return writeConfig(context, `${worker}.json`, config);
}
async function scheduledEntry(main, { root, teardown }) {
  const path = join(root, "control-plane.mjs");
  const job = resolve(repoRoot, teardown.module);
  await writeFile(
    path,
    `import app from ${JSON.stringify(main)};
export * from ${JSON.stringify(main)};
import { ${teardown.exportName} as runScheduledJob } from ${JSON.stringify(job)};
export default { ...app, async fetch(request, env, ctx) {
  if (new URL(request.url).pathname === "/__e2e/teardown" && request.method === "POST") {
    await runScheduledJob(env, { cron: "* * * * *", scheduledTime: Date.now(), noRetry() {} }, ctx);
    return Response.json({ complete: true });
  }
  return app.fetch(request, env, ctx);
} };`,
    { mode: 0o600 },
  );
  return path;
}
async function gatewayConfig({ root, agent, workers }) {
  const path = join(root, "gateway.mjs");
  await writeFile(
    path,
    `export default { async fetch(request, env) {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\\/__fleet\\/([^/]+)(\\/.*)?$/);
  const binding = match ? match[1].replaceAll("-", "_") : "control_plane_api";
  if (match) url.pathname = match[2] ?? "/";
  if (!env[binding]) return new Response("Unknown fixture service", { status: 404 });
  return env[binding].fetch(new Request(url, request));
} };`,
    { mode: 0o600 },
  );
  return writeConfig({ root }, "gateway.json", {
    name: `local-e2e-gateway-${agent}`,
    main: path,
    compatibility_date: "2026-06-21",
    services: workers.map((worker) => ({
      binding: worker.replaceAll("-", "_"),
      service: `splitch-${worker}-${agent}`,
    })),
  });
}
async function writeConfig({ root }, name, config) {
  const path = join(root, name);
  await writeFile(path, JSON.stringify(config), { mode: 0o600 });
  return path;
}

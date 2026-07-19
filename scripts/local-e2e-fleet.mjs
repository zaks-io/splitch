#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import {
  LOCAL_E2E_D1_SEED,
  LOCAL_E2E_MEMBER_SESSION_KEY,
  LOCAL_E2E_SESSION_KEY,
  localE2eMemberSession,
  localE2eSession,
} from "./local-e2e-fixtures.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const persistPath = resolve(repoRoot, "test-results/control-panel-e2e-state");
const localBindings = {
  SENTRY_DSN: "",
  SPLITCH_DEPLOY_GATE_TOKEN: "local-e2e-deploy-gate",
  WORKOS_API_KEY: "local-e2e-workos-api-key",
  WORKOS_CLIENT_ID: "local-e2e-workos-client-id",
};
const workers = [
  {
    name: "analysis-api-fixture",
    origin: "http://127.0.0.1:8790",
    command: "node",
    args: ["scripts/local-e2e-analysis-fixture.mjs"],
  },
  {
    name: "control-plane-api",
    origin: "http://127.0.0.1:18790",
    command: "pnpm",
    args: [
      "exec",
      "wrangler",
      "dev",
      "--config",
      "apps/control-plane-api/wrangler.jsonc",
      "--local",
      "--ip",
      "127.0.0.1",
      "--port",
      "18790",
      "--persist-to",
      persistPath,
    ],
  },
  {
    name: "control-panel",
    origin: "http://127.0.0.1:18793",
    command: "pnpm",
    args: [
      "--filter",
      "@splitch/control-panel",
      "exec",
      "vite",
      "dev",
      "--host",
      "127.0.0.1",
      "--port",
      "18793",
    ],
    env: {
      ...localBindings,
      SPLITCH_LOCAL_E2E_PERSIST_PATH: persistPath,
    },
  },
];

export async function waitForHealth(
  worker,
  { timeoutMs = 60_000, fetchImpl = fetch, pollMs = 250, runId } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let lastFailure = "no response";
  while (Date.now() < deadline) {
    if (worker.process?.exitCode !== null) {
      throw new Error(`${worker.name} exited ${worker.process.exitCode} before becoming healthy`);
    }
    lastFailure = await probeHealth(worker, fetchImpl, runId);
    if (!lastFailure) return;
    await new Promise((done) => setTimeout(done, pollMs));
  }
  throw new Error(`${worker.name} failed health check: ${lastFailure}`);
}

async function probeHealth(worker, fetchImpl, runId) {
  try {
    const response = await fetchImpl(`${worker.origin}/health`);
    if (!response.ok) return `HTTP ${response.status}`;
    const responseRunId = response.headers.get("x-splitch-local-e2e-run-id");
    return !runId || responseRunId === runId ? "" : "health response belongs to another run";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function watchWorker(worker) {
  return new Promise((resolveStop) => {
    worker.process.once("error", (error) => {
      resolveStop({ name: worker.name, error });
    });
    worker.process.once("exit", (code, signal) => {
      resolveStop({ name: worker.name, code, signal });
    });
  });
}

export async function failOnWorkerStop(running) {
  const stopped = await Promise.race(running.map((worker) => worker.stopped));
  const detail = stopped.error?.message ?? stopped.signal ?? `exit ${stopped.code ?? "unknown"}`;
  throw new Error(`${stopped.name} stopped unexpectedly (${detail})`);
}

export async function waitForFleetReady(running, healthOptions) {
  await Promise.race([
    Promise.all(running.map((worker) => waitForHealth(worker, healthOptions))),
    failOnWorkerStop(running),
  ]);
}

function createReadinessServer(runId) {
  let ready = false;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1:18799");
    if (url.pathname !== "/health" || url.searchParams.get("run") !== runId) {
      response.writeHead(404).end("not found");
      return;
    }
    response.writeHead(ready ? 200 : 503, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: ready, service: "local-e2e-fleet" }));
  });
  return {
    server,
    markReady() {
      ready = true;
    },
  };
}

function listen(server, port = 18799) {
  return new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, "127.0.0.1", resolveListen);
  });
}

function runWrangler(args) {
  const result = spawnSync("pnpm", ["exec", "wrangler", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, CI: "true" },
  });
  if (result.status !== 0) {
    throw new Error(
      `wrangler ${args.slice(0, 3).join(" ")} failed\n${result.stdout}${result.stderr}`,
    );
  }
}

function seedLocalResources() {
  rmSync(persistPath, { recursive: true, force: true });
  mkdirSync(persistPath, { recursive: true });
  runWrangler([
    "d1",
    "migrations",
    "apply",
    "DB",
    "--local",
    "--config",
    "packages/db/wrangler.jsonc",
    "--persist-to",
    persistPath,
  ]);
  runWrangler([
    "d1",
    "execute",
    "DB",
    "--local",
    "--config",
    "packages/db/wrangler.jsonc",
    "--persist-to",
    persistPath,
    "--command",
    LOCAL_E2E_D1_SEED,
  ]);
  runWrangler([
    "kv",
    "key",
    "put",
    LOCAL_E2E_SESSION_KEY,
    JSON.stringify(localE2eSession()),
    "--binding",
    "SESSION_STORE",
    "--local",
    "--config",
    "apps/control-panel/wrangler.jsonc",
    "--persist-to",
    persistPath,
  ]);
  runWrangler([
    "kv",
    "key",
    "put",
    LOCAL_E2E_MEMBER_SESSION_KEY,
    JSON.stringify(localE2eMemberSession()),
    "--binding",
    "SESSION_STORE",
    "--local",
    "--config",
    "apps/control-panel/wrangler.jsonc",
    "--persist-to",
    persistPath,
  ]);
}

function launchWorkers(runId) {
  return workers.map((worker) => {
    const args =
      worker.name === "control-plane-api"
        ? [...worker.args, "--var", `SPLITCH_LOCAL_E2E_RUN_ID:${runId}`]
        : worker.args;
    const child = spawn(worker.command, args, {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...localBindings,
        ...worker.env,
        CI: "true",
        SPLITCH_LOCAL_E2E_RUN_ID: runId,
      },
      stdio: "inherit",
    });
    const runningWorker = { ...worker, process: child };
    return { ...runningWorker, stopped: watchWorker(runningWorker) };
  });
}

export async function bootFleet(
  runId,
  { listenImpl = listen, seed = seedLocalResources, launch = launchWorkers } = {},
) {
  const readiness = createReadinessServer(runId);
  await listenImpl(readiness.server);
  try {
    seed();
    return { readiness, running: launch(runId) };
  } catch (error) {
    readiness.server.close();
    throw error;
  }
}

async function main() {
  const runId = process.argv[2];
  if (!runId) throw new Error("missing local E2E run ID");
  const { readiness, running } = await bootFleet(runId);

  const stop = () => {
    for (const worker of running) worker.process.kill("SIGTERM");
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    await waitForFleetReady(running, { runId });
    readiness.markReady();
    console.log(`local-e2e-fleet: healthy (${running.map((worker) => worker.name).join(", ")})`);
    await failOnWorkerStop(running);
  } finally {
    readiness.server.close();
    stop();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch((error) => {
    console.error(`local-e2e-fleet: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import {
  LOCAL_E2E_D1_SEED,
  LOCAL_E2E_SESSION_KEY,
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
  { timeoutMs = 60_000, fetchImpl = fetch, pollMs = 250 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let lastFailure = "no response";
  while (Date.now() < deadline) {
    if (worker.process?.exitCode !== null) {
      throw new Error(`${worker.name} exited ${worker.process.exitCode} before becoming healthy`);
    }
    try {
      const response = await fetchImpl(`${worker.origin}/health`);
      if (response.ok) return;
      lastFailure = `HTTP ${response.status}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    await new Promise((done) => setTimeout(done, pollMs));
  }
  throw new Error(`${worker.name} failed health check: ${lastFailure}`);
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
}

async function main() {
  seedLocalResources();
  const running = workers.map((worker) => {
    const child = spawn(worker.command, worker.args, {
      cwd: repoRoot,
      env: { ...process.env, ...localBindings, ...worker.env, CI: "true" },
      stdio: "inherit",
    });
    return { ...worker, process: child };
  });

  const stop = () => {
    for (const worker of running) worker.process.kill("SIGTERM");
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    await Promise.all(running.map((worker) => waitForHealth(worker)));
    console.log(`local-e2e-fleet: healthy (${running.map((worker) => worker.name).join(", ")})`);
    const ended = await Promise.race(
      running.map(
        (worker) =>
          new Promise((resolveExit) =>
            worker.process.once("exit", (code, signal) =>
              resolveExit({ name: worker.name, code, signal }),
            ),
          ),
      ),
    );
    throw new Error(
      `${ended.name} stopped unexpectedly (${ended.signal ?? `exit ${ended.code ?? "unknown"}`})`,
    );
  } finally {
    stop();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch((error) => {
    console.error(`local-e2e-fleet: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

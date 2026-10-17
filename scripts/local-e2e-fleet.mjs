#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import {
  LOCAL_E2E_D1_SEED,
  LOCAL_E2E_MEMBER_PROFILES,
  LOCAL_E2E_MEMBER_SESSION_KEY,
  LOCAL_E2E_NEWCOMER_SESSION_KEY,
  LOCAL_E2E_SESSION_KEY,
  localE2eMemberSession,
  localE2eNewcomerSession,
  localE2eSession,
  memberProfileKey,
} from "./local-e2e-fixtures.mjs";
import { localE2eWorkers, wranglerBin } from "./local-e2e-fleet-config.mjs";
import { createFaultTracker } from "./local-e2e-fleet-faults.mjs";
import {
  createSupervisor,
  createTaskScope,
  failOnWorkerStop,
  launchWorker,
  stopChild,
} from "./local-e2e-fleet-supervisor.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const persistPath = resolve(repoRoot, "test-results/control-panel-e2e-state");
const workers = localE2eWorkers(persistPath, {
  full: process.env.SPLITCH_LOCAL_DEV_FLEET === "true",
});
const faultTracker = createFaultTracker();

export async function waitForHealth(
  worker,
  { timeoutMs = 60_000, fetchImpl = fetch, pollMs = 250, runId, signal } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let lastFailure = "no response";
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    if (worker.process && worker.process.exitCode !== null) {
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
    const response = await fetchImpl(`${worker.origin}/health`, {
      signal: AbortSignal.timeout(1_000),
    });
    if (response.ok && !(await expectedService(response, worker)))
      return "unexpected service identity";
    if (!response.ok) return `HTTP ${response.status}`;
    const responseRunId = response.headers.get("x-splitch-local-e2e-run-id");
    return !runId || worker.checkRunId === false || responseRunId === runId
      ? ""
      : "health response belongs to another run";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function expectedService(response, worker) {
  if (!worker.service) return true;
  const body = await response.clone().json();
  return body.service === worker.service && body.platformTarget === "local";
}

export async function waitForFleetReady(running, healthOptions) {
  await Promise.race([
    Promise.all(running.map((worker) => waitForHealth(worker, healthOptions))),
    failOnWorkerStop(running),
  ]);
}

function createReadinessServer(runId, tracker = faultTracker) {
  let ready = false;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1:18799");
    if (url.searchParams.get("run") !== runId) {
      response.writeHead(404).end("not found");
      return;
    }
    // SPL-181: the Playwright fault reporter reads this to attribute a failing
    // spec to the harness instead of to the product code under test.
    if (url.pathname === "/faults") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ faults: tracker.list() }));
      return;
    }
    if (url.pathname !== "/health") {
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
  const result = spawnSync(process.execPath, [wranglerBin, ...args], {
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
  const sessionStoreEntries = [
    [LOCAL_E2E_SESSION_KEY, localE2eSession()],
    [LOCAL_E2E_MEMBER_SESSION_KEY, localE2eMemberSession()],
    [LOCAL_E2E_NEWCOMER_SESSION_KEY, localE2eNewcomerSession()],
    ...Object.entries(LOCAL_E2E_MEMBER_PROFILES).map(([userId, email]) => [
      memberProfileKey(userId),
      { email },
    ]),
  ];
  for (const [key, value] of sessionStoreEntries) {
    runWrangler([
      "kv",
      "key",
      "put",
      key,
      JSON.stringify(value),
      "--binding",
      "SESSION_STORE",
      "--local",
      "--config",
      "apps/control-panel/wrangler.jsonc",
      "--persist-to",
      persistPath,
    ]);
  }
}

function launchWorkers(runId) {
  return workers.map((worker) => launchWorker(worker, runId, faultTracker));
}

export async function bootFleet(
  runId,
  {
    listenImpl = listen,
    seed = seedLocalResources,
    launch = launchWorkers,
    readinessPort = 18799,
    tracker = faultTracker,
  } = {},
) {
  const readiness = createReadinessServer(runId, tracker);
  await listenImpl(readiness.server, readinessPort);
  try {
    await seed();
    return { readiness, running: await launch(runId) };
  } catch (error) {
    readiness.server.close();
    throw error;
  }
}

// Scenario fleets share readiness, fault attribution and restart policy with panel E2E.
export async function startManagedFleet(runId, { workers, seed, signal }) {
  const tracker = createFaultTracker();
  const controller = new AbortController();
  const tasks = createTaskScope(signal);
  const launched = [];
  const running = [];
  let readiness;
  let monitored;
  async function launch(worker) {
    const replacement = launchWorker(worker, runId, tracker, { quiet: true });
    launched.push(replacement);
    const index = running.findIndex((candidate) => candidate.name === worker.name);
    if (index < 0) running.push(replacement);
    else running[index] = replacement;
    return replacement;
  }
  const health = (worker, options) =>
    Promise.all(
      (worker.healthTargets ?? [worker]).map((target) =>
        waitForHealth(
          { ...target, process: worker.process },
          { ...options, signal, timeoutMs: 120_000 },
        ),
      ),
    );
  const lifecycle = {
    run: (task) => tasks.run(task, monitored),
    diagnostics: () => ({
      storageFaults: tracker.count,
      restarts: launched.length - workers.length,
    }),
    async close() {
      await tasks.close();
      controller.abort();
      if (readiness?.server.listening) await new Promise((done) => readiness.server.close(done));
      for (const worker of launched.toReversed()) await stopChild(worker);
      await monitored?.catch(() => {});
    },
  };
  try {
    ({ readiness } = await bootFleet(runId, {
      seed,
      tracker,
      readinessPort: 0,
      launch: async () => {
        for (const worker of workers) await launch(worker);
        return running;
      },
    }));
    await Promise.all(running.map((worker) => health(worker, { runId })));
    readiness.markReady();
    const supervisor = createSupervisor({
      tracker,
      runId,
      relaunch: async (worker) => {
        await stopChild(worker);
        return launch(worker);
      },
      waitForHealth: health,
      log: () => console.error("local-e2e-fleet: recovering a storage harness fault"),
    });
    monitored = tasks.watch(supervisor.supervise(running, { signal: controller.signal }));
    return lifecycle;
  } catch (error) {
    await lifecycle.close();
    throw error;
  }
}

async function main() {
  const runId = process.argv[2];
  if (!runId) throw new Error("missing local E2E run ID");
  const { readiness, running } = await bootFleet(runId);

  const stop = () => {
    for (const worker of running) void stopChild(worker);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  const supervisor = createSupervisor({
    tracker: faultTracker,
    runId,
    relaunch: (worker) => {
      const replacement = launchWorker(worker, runId, faultTracker);
      running[running.findIndex((candidate) => candidate.name === worker.name)] = replacement;
      return replacement;
    },
    waitForHealth,
  });

  try {
    await waitForFleetReady(running, { runId });
    readiness.markReady();
    console.log(`local-e2e-fleet: healthy (${running.map((worker) => worker.name).join(", ")})`);
    await supervisor.supervise(running);
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

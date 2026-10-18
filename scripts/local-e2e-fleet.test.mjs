import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  bootFleet,
  startManagedFleet,
  waitForFleetReady,
  waitForHealth,
} from "./local-e2e-fleet.mjs";
import { failOnWorkerStop, watchWorker } from "./local-e2e-fleet-supervisor.mjs";

test("a readiness port collision prevents fixture seeding and Worker launch", async () => {
  let seeded = false;
  let launched = false;
  await assert.rejects(
    bootFleet("collision-run", {
      listenImpl: async () => {
        throw new Error("listen EADDRINUSE: address already in use 127.0.0.1:18799");
      },
      seed: () => {
        seeded = true;
      },
      launch: () => {
        launched = true;
        return [];
      },
    }),
    /EADDRINUSE/,
  );
  assert.equal(seeded, false);
  assert.equal(launched, false);
});

test("local E2E fleet health checks fail loud", async () => {
  await assert.rejects(
    waitForHealth(
      { name: "broken-worker", origin: "http://broken.invalid", process: { exitCode: null } },
      {
        timeoutMs: 10,
        pollMs: 1,
        fetchImpl: async () => new Response("not ready", { status: 503 }),
      },
    ),
    /broken-worker failed health check: HTTP 503/,
  );
});

test("local E2E fleet health checks reject an exited Worker immediately", async () => {
  await assert.rejects(
    waitForHealth({
      name: "crashed-worker",
      origin: "http://crashed.invalid",
      process: { exitCode: 2 },
    }),
    /crashed-worker exited 2 before becoming healthy/,
  );
});

test("local E2E fleet rejects a healthy response owned by another run", async () => {
  await assert.rejects(
    waitForHealth(
      { name: "stale-worker", origin: "http://stale.test", process: { exitCode: null } },
      {
        runId: "current-run",
        timeoutMs: 10,
        pollMs: 1,
        fetchImpl: async () =>
          new Response("ready", {
            headers: { "x-splitch-local-e2e-run-id": "stale-run" },
          }),
      },
    ),
    /stale-worker failed health check: health response belongs to another run/,
  );
});

test("fleet readiness waits for every Worker, not only the panel", async () => {
  const running = [
    fakeWorker("control-panel", "http://panel.test"),
    fakeWorker("control-plane-api", "http://api.test"),
  ];
  await assert.rejects(
    waitForFleetReady(running, {
      timeoutMs: 10,
      pollMs: 1,
      fetchImpl: async (url) =>
        url.startsWith("http://panel.test")
          ? new Response("ready")
          : new Response("not ready", { status: 503 }),
    }),
    /control-plane-api failed health check: HTTP 503/,
  );
});

test("fleet monitoring fails loud when a healthy Worker exits", async () => {
  const worker = fakeWorker("control-plane-api", "http://api.test");
  await waitForFleetReady([worker], { fetchImpl: async () => new Response("ready") });
  const stopped = failOnWorkerStop([worker]);
  worker.process.emit("exit", 2, null);
  await assert.rejects(stopped, /control-plane-api stopped unexpectedly \(exit 2\)/);
});

function fakeWorker(name, origin) {
  const process = new EventEmitter();
  process.exitCode = null;
  const worker = { name, origin, process };
  return { ...worker, stopped: watchWorker(worker) };
}

test("isolated readiness binds its assigned port and awaits asynchronous seeding before launch", async () => {
  let seeded = false;
  const fleet = await bootFleet("isolated-run", {
    readinessPort: 0,
    listenImpl: async (server, port) => {
      assert.equal(port, 0);
      await new Promise((done) => server.listen(port, "127.0.0.1", done));
    },
    seed: async () => {
      await Promise.resolve();
      seeded = true;
    },
    launch: () => {
      assert.equal(seeded, true);
      return [];
    },
  });
  await new Promise((done) => fleet.readiness.server.close(done));
});

test("standalone fleet health rejects a different service behind its gateway", async () => {
  await assert.rejects(
    waitForHealth(
      {
        name: "evaluation-api",
        origin: "http://gateway.test",
        process: { exitCode: null },
        service: "splitch-evaluation-api",
      },
      {
        timeoutMs: 10,
        pollMs: 1,
        fetchImpl: async () =>
          Response.json({ service: "splitch-control-plane-api", platformTarget: "local" }),
      },
    ),
    /unexpected service identity/,
  );
});

test("supervisor failure cancels a long scenario and cleanup awaits its finalizer", {
  timeout: 3_000,
}, async (context) => {
  let failWorker = false;
  const server = createServer((request, response) => {
    response.end(request.url === "/fault-state" && failWorker ? "fail" : "ready");
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const fleet = await startManagedFleet("fault-test", {
    seed: async () => {},
    workers: [
      {
        name: "fault-worker",
        origin,
        checkRunId: false,
        command: process.execPath,
        args: [
          "-e",
          `setInterval(async () => { if (await fetch(${JSON.stringify(`${origin}/fault-state`)}).then(r => r.text()) === 'fail') process.exit(1); }, 10);`,
        ],
      },
    ],
  });
  let releaseFinalizer;
  const finalizerGate = new Promise((done) => {
    releaseFinalizer = done;
  });
  context.after(async () => {
    releaseFinalizer();
    await fleet.close();
    await new Promise((done) => server.close(done));
  });
  let taskBegan, finalizerBegan;
  const started = new Promise((done) => {
    taskBegan = done;
  });
  const finalizing = new Promise((done) => {
    finalizerBegan = done;
  });
  let requestedStoppedFleet = false;
  let finalized = false;
  let runSettled = false;
  const run = fleet.run(async (signal) => {
    taskBegan();
    try {
      await delay(75_000, undefined, { signal });
      requestedStoppedFleet = true;
      await fetch(`${origin}/after-expiry`, { signal });
    } finally {
      finalizerBegan();
      await finalizerGate;
      finalized = true;
    }
  });
  run.then(
    () => {
      runSettled = true;
    },
    () => {
      runSettled = true;
    },
  );
  await started;
  failWorker = true;
  await finalizing;
  assert.equal(runSettled, false, "run must await cancellation and finalization");
  let cleaned = false;
  const closing = fleet.close().then(() => {
    cleaned = true;
  });
  await Promise.resolve();
  assert.equal(cleaned, false, "private state cleanup must wait for scenario settlement");
  releaseFinalizer();
  await assert.rejects(run, /fault-worker stopped unexpectedly/);
  await closing;
  assert.equal(finalized, true);
  assert.equal(requestedStoppedFleet, false);
});

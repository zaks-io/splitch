import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { watchWorker } from "./local-e2e-fleet.mjs";
import { createFaultTracker } from "./local-e2e-fleet-faults.mjs";
import { createSupervisor } from "./local-e2e-fleet-supervisor.mjs";

test("a Worker that dies without the harness signature still fails loud", async () => {
  const tracker = createFaultTracker();
  const worker = fakeWorker("control-plane-api");
  const supervisor = createSupervisor({
    tracker,
    relaunch: () => assert.fail("must not restart an unexplained death"),
    waitForHealth: async () => {},
    log: () => {},
  });
  const supervised = supervisor.supervise([worker]);
  worker.process.emit("exit", 2, null);
  await assert.rejects(supervised, /control-plane-api stopped unexpectedly \(exit 2\)/);
});

test("a Worker killed by the D1 crash is named and restarted, and the run continues", async () => {
  const tracker = createFaultTracker({ now: () => 5 });
  const worker = fakeWorker("control-panel");
  const logs = [];
  let relaunched = 0;
  const supervisor = createSupervisor({
    tracker,
    relaunch: () => {
      relaunched += 1;
      return fakeWorker("control-panel");
    },
    waitForHealth: async () => {},
    log: (line) => logs.push(line),
  });

  tracker.scan("control-panel", "NOSENTRY database is locked: SQLITE_BUSY\n");
  const supervised = supervisor.supervise([worker]);
  worker.process.emit("exit", 1, null);
  await Promise.race([supervised, tick()]);

  assert.equal(relaunched, 1);
  assert.ok(
    logs.some((line) => line.startsWith("SPL-181 harness fault: miniflare D1 crashed")),
    `expected the SPL-181 label in ${JSON.stringify(logs)}`,
  );
});

test("a Worker that keeps crashing gives up rather than restarting forever", async () => {
  const tracker = createFaultTracker({ now: () => 5 });
  const workers = [];
  const supervisor = createSupervisor({
    tracker,
    maxRestarts: 2,
    relaunch: () => {
      const replacement = fakeWorker("control-panel");
      workers.push(replacement);
      queueMicrotask(() => replacement.process.emit("exit", 1, null));
      return replacement;
    },
    waitForHealth: async () => {},
    log: () => {},
  });

  tracker.scan("control-panel", "SQLITE_BUSY\n");
  const first = fakeWorker("control-panel");
  const supervised = supervisor.supervise([first]);
  first.process.emit("exit", 1, null);
  await assert.rejects(supervised, /giving up after 2 restarts/);
});

test("faults from a previous life do not excuse a later unexplained death", async () => {
  let clock = 1;
  const tracker = createFaultTracker({ now: () => clock });
  tracker.scan("control-panel", "SQLITE_BUSY\n");
  clock = 100;
  const worker = fakeWorker("control-panel", 50);
  const supervisor = createSupervisor({
    tracker,
    relaunch: () => assert.fail("must not restart"),
    waitForHealth: async () => {},
    log: () => {},
  });
  const supervised = supervisor.supervise([worker]);
  worker.process.emit("exit", 3, null);
  await assert.rejects(supervised, /control-panel stopped unexpectedly \(exit 3\)/);
});

function tick() {
  return new Promise((done) => setTimeout(done, 5));
}

function fakeWorker(name, startedAt = 0) {
  const process = new EventEmitter();
  process.exitCode = null;
  const worker = { name, origin: `http://${name}.test`, process, startedAt };
  return { ...worker, stopped: watchWorker(worker) };
}

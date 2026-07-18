import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  failOnWorkerStop,
  waitForFleetReady,
  waitForHealth,
  watchWorker,
} from "./local-e2e-fleet.mjs";

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

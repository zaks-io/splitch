import assert from "node:assert/strict";
import test from "node:test";
import { waitForHealth } from "./local-e2e-fleet.mjs";

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

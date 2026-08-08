import assert from "node:assert/strict";
import test from "node:test";
import { CREDENTIAL_CACHE_BACKFILL_CHECKPOINT_VERSION } from "../packages/contracts/src/credential-cache-backfill.ts";
import { completeCredentialCacheBackfill } from "./complete-credential-cache-backfill.mjs";

test("drives the protected credential cache backfill to a verified done checkpoint", async () => {
  const checkpoints = [
    { version: CREDENTIAL_CACHE_BACKFILL_CHECKPOINT_VERSION, kind: "client" },
    { version: CREDENTIAL_CACHE_BACKFILL_CHECKPOINT_VERSION, kind: "api" },
    { version: CREDENTIAL_CACHE_BACKFILL_CHECKPOINT_VERSION, kind: "done" },
  ];
  const calls = [];

  await completeCredentialCacheBackfill({
    origin: "https://api.example.test",
    token: "gate-token",
    fetchImpl: async (input, init) => {
      calls.push({
        method: init?.method ?? "GET",
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return Response.json(checkpoints.shift() ?? { kind: "done" });
    },
  });

  assert.deepEqual(calls, [
    {
      method: "GET",
      url: "https://api.example.test/internal/credential-cache-backfill/status",
      authorization: "Bearer gate-token",
    },
    {
      method: "POST",
      url: "https://api.example.test/internal/credential-cache-backfill/run",
      authorization: "Bearer gate-token",
    },
    {
      method: "POST",
      url: "https://api.example.test/internal/credential-cache-backfill/run",
      authorization: "Bearer gate-token",
    },
  ]);
});

test("waits for the compatible Control Plane checkpoint before running the backfill", async () => {
  const checkpoints = [
    { kind: "done" },
    { version: CREDENTIAL_CACHE_BACKFILL_CHECKPOINT_VERSION, kind: "done" },
  ];
  const sleeps = [];

  await completeCredentialCacheBackfill({
    origin: "https://api.example.test",
    token: "gate-token",
    fetchImpl: async () => Response.json(checkpoints.shift()),
    sleepImpl: async (milliseconds) => sleeps.push(milliseconds),
  });

  assert.deepEqual(sleeps, [1_000]);
});

test("retries a 404 until the compatible Control Plane exposes the migration gate", async () => {
  const responses = [
    new Response(null, { status: 404 }),
    Response.json({ version: CREDENTIAL_CACHE_BACKFILL_CHECKPOINT_VERSION, kind: "done" }),
  ];
  const sleeps = [];

  await completeCredentialCacheBackfill({
    origin: "https://api.example.test",
    token: "gate-token",
    fetchImpl: async () => responses.shift(),
    sleepImpl: async (milliseconds) => sleeps.push(milliseconds),
  });

  assert.deepEqual(sleeps, [1_000]);
});

test("fails immediately when the migration gate returns a server error", async () => {
  let sleeps = 0;

  await assert.rejects(
    completeCredentialCacheBackfill({
      origin: "https://api.example.test",
      token: "gate-token",
      fetchImpl: async () => new Response(null, { status: 500 }),
      sleepImpl: async () => {
        sleeps += 1;
      },
    }),
    /credential cache backfill gate returned HTTP 500/u,
  );
  assert.equal(sleeps, 0);
});

test("fails loud when the compatible Control Plane checkpoint does not appear", async () => {
  let now = 0;
  let requests = 0;
  await assert.rejects(
    completeCredentialCacheBackfill({
      origin: "https://api.example.test",
      token: "gate-token",
      fetchImpl: async () => {
        requests += 1;
        throw new TypeError("connection refused");
      },
      sleepImpl: async (milliseconds) => {
        now += milliseconds;
      },
      nowMs: () => now,
    }),
    /timed out after 30000ms waiting for credential cache backfill checkpoint version 2 from the compatible Control Plane; the release is half-live/u,
  );
  assert.equal(requests, 31);
});

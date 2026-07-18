import assert from "node:assert/strict";
import test from "node:test";
import { completeCredentialCacheBackfill } from "./complete-credential-cache-backfill.mjs";

test("drives the protected credential cache backfill to a verified done checkpoint", async () => {
  const checkpoints = [{ kind: "client" }, { kind: "api" }, { kind: "done" }];
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

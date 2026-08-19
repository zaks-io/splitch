import assert from "node:assert/strict";
import test from "node:test";
import { assertPropagationThresholds, median, readConfig } from "./flag-propagation-production.mjs";

test("production harness requires an explicit mutation confirmation", () => {
  assert.throws(() => readConfig({}), /production mutation confirmation is required/u);
});

test("production harness requires every credential and scope input", () => {
  assert.throws(
    () =>
      readConfig({
        SPLITCH_PROPAGATION_CONFIRM_PRODUCTION: "I_UNDERSTAND_THIS_MUTATES_PRODUCTION",
      }),
    /SPLITCH_PROPAGATION_CLIENT_ID is required/u,
  );
});

test("median handles even and odd measurement counts", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
});

test("six toggles must have median and maximum strictly below five seconds", () => {
  const green = [100, 200, 300, 400, 500, 4_999].map((elapsedMs) => ({ elapsedMs }));
  assert.deepEqual(assertPropagationThresholds(green), { medianMs: 350, maxMs: 4_999 });

  const red = [100, 200, 300, 400, 500, 5_000].map((elapsedMs) => ({ elapsedMs }));
  assert.throws(() => assertPropagationThresholds(red), /propagation threshold breached/u);
});

test("waitForResolution keeps polling through transient verify HTTP errors", async () => {
  const { waitForResolution } = await import("./flag-propagation-production.mjs");
  let polls = 0;
  const result = await waitForResolution(
    {
      evaluationBaseUrl: "https://evaluation.example",
      clientKey: "pk_test",
      flagKey: "checkout",
    },
    {
      now: () => polls * 100,
      sleep: async () => {},
      fetch: async () => {
        polls += 1;
        if (polls < 3) {
          return new Response(JSON.stringify({ error: "SERVICE_UNAVAILABLE" }), { status: 503 });
        }
        return new Response(JSON.stringify({ reason: "TARGETING_MATCH", variant: true }), {
          status: 200,
          headers: { "cf-ray": "ray-1" },
        });
      },
    },
    { enabled: true, toggle: 1, version: 2, runId: "run-1" },
  );

  assert.equal(result.polls, 3);
  assert.equal(result.elapsedMs, 300);
  assert.equal(result.cfRay, "ray-1");
});

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

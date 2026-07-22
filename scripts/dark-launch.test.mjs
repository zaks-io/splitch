import assert from "node:assert/strict";
import test from "node:test";
import {
  assertVariant,
  DEFAULT_VARIANT,
  LAUNCH_VARIANT,
  PROPAGATION_WINDOW_MS,
  syntheticKeys,
  variantName,
} from "./dark-launch/journey.mjs";

test("syntheticKeys produces stable, lowercase App and Flag keys", () => {
  const keys = syntheticKeys("Run_ABC-123");
  assert.match(keys.appKey, /^dark-launch-app-/);
  assert.match(keys.flagKey, /^dark-launch-/);
  assert.equal(keys.appKey, keys.appKey.toLowerCase());
  assert.equal(keys.flagKey, keys.flagKey.toLowerCase());
});

test("variantName maps boolean values and explicit variantName", () => {
  assert.equal(variantName({ value: false, variantName: null }), DEFAULT_VARIANT);
  assert.equal(variantName({ value: true, variantName: null }), LAUNCH_VARIANT);
  assert.equal(variantName({ value: true, variantName: "on" }), "on");
});

test("assertVariant rejects ERROR resolutions", () => {
  assert.throws(
    () => assertVariant({ value: false, variantName: "off", reason: "ERROR" }, "off", "probe"),
    /failed loud/,
  );
});

test("propagation window matches the documented 60s KV lag", () => {
  assert.equal(PROPAGATION_WINDOW_MS, 60_000);
});

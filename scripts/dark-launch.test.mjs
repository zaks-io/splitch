import assert from "node:assert/strict";
import test from "node:test";
import { assertStructuredAuthFailure } from "./dark-launch/cleanup.mjs";
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

test("assertStructuredAuthFailure requires the expected errorCode", async () => {
  await assertStructuredAuthFailure(
    async () => ({ reason: "ERROR", errorCode: "FLAG_NOT_FOUND", value: false }),
    "FLAG_NOT_FOUND",
    "wrong-App",
  );

  await assert.rejects(
    () =>
      assertStructuredAuthFailure(
        async () => ({ reason: "ERROR", errorCode: "UNAUTHORIZED", value: false }),
        "FLAG_NOT_FOUND",
        "wrong-App",
      ),
    /expected errorCode FLAG_NOT_FOUND/,
  );

  await assert.rejects(
    () =>
      assertStructuredAuthFailure(
        async () => {
          throw new Error("network down");
        },
        "CREDENTIAL_REVOKED",
        "revoked",
      ),
    /but the call threw/,
  );

  await assert.rejects(
    () =>
      assertStructuredAuthFailure(
        async () => ({ reason: "DEFAULT", value: false }),
        "CREDENTIAL_REVOKED",
        "revoked",
      ),
    /expected reason ERROR/,
  );
});

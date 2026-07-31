import assert from "node:assert/strict";
import test from "node:test";
import { assertStructuredAuthFailure } from "./dark-launch/cleanup.mjs";
import {
  createDarkLaunchFlag,
  deleteFlag,
  replaceTargetingRules,
  updateFlagConfig,
} from "./dark-launch/control-plane.mjs";
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

test("dark-launch Flag mutations use current idempotency and deletion approval contracts", async () => {
  const requests = [];
  const deps = {
    accessToken: "test-access-token",
    controlPlaneBaseUrl: "https://control-plane.example.test",
    runId: "run-123",
    fetch: async (url, init) => {
      requests.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
      if (init.method === "DELETE") {
        return Response.json(
          {
            code: "APPROVAL_REVIEW_REQUIRED",
            message: "Approval Request is pending Review",
            details: { approvalRequestId: "approval-123" },
          },
          { status: 409 },
        );
      }
      return Response.json(
        url.endsWith("/flags")
          ? {
              id: "flag-123",
              variants: [
                { id: "variant-on", name: LAUNCH_VARIANT, value: true, isDefault: false },
                { id: "variant-off", name: DEFAULT_VARIANT, value: false, isDefault: true },
              ],
            }
          : { status: "applied" },
      );
    },
  };

  await createDarkLaunchFlag(deps, "app-123", "flag-key");
  await updateFlagConfig(deps, "app-123", "env-123", "flag-123", { enabled: true });
  await replaceTargetingRules(deps, "app-123", "env-123", "flag-123", []);
  await deleteFlag(deps, "app-123", "flag-123");

  assert.equal(requests[0].body.idempotency_key, "dark-launch-flag-create-run-123");
  assert.equal(requests[1].body.idempotency_key, "dark-launch-flag-config-enable-run-123");
  assert.equal(requests[2].body.idempotency_key, "dark-launch-targeting-rules-run-123");
  assert.equal(requests[3].init.headers["idempotency-key"], "dark-launch-flag-delete-run-123");
  assert.equal(
    requests[4].url,
    "https://control-plane.example.test/apps/app-123/approval-requests/approval-123/reviews",
  );
  assert.deepEqual(requests[4].body, {
    action: "approve_and_apply",
    idempotency_key: "dark-launch-flag-delete-review-run-123",
  });
});

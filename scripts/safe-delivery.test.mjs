import assert from "node:assert/strict";
import test from "node:test";

import { readConfig } from "./safe-delivery/config.mjs";
import {
  assertVariant,
  DANGLING_VARIANT,
  DEFAULT_VARIANT,
  FIELD_GROUPS,
  LAUNCH_VARIANT,
  syntheticKeys,
  transientFlagKeys,
  variantName,
} from "./safe-delivery/constants.mjs";
import {
  createFlag,
  promoteFlagConfig,
  requireOk,
  requireRefused,
  reviewApprovalRequest,
} from "./safe-delivery/control-plane.mjs";
import { flagConfig as config } from "./safe-delivery/flag-config-fixture.mjs";

const COMMIT = "0".repeat(40);

test("synthetic run identities are isolated between consecutive runs", () => {
  const first = syntheticKeys("run-1-r1");
  const second = syntheticKeys("run-1-r2");
  for (const field of Object.keys(first)) {
    assert.notEqual(first[field], second[field], `${field} collided across runs`);
  }
  assert.equal(transientFlagKeys(first).length, 3);
  for (const key of transientFlagKeys(first)) {
    assert.ok(key.startsWith("safe-delivery-"), `${key} is not sweepable by the orphan prefix`);
  }
});

test("Targeting Keys carry no personal data", () => {
  const keys = syntheticKeys("run-1-r1");
  for (const key of [keys.targetedKey, keys.untargetedKey]) {
    assert.match(key, /^safe-delivery-user-(un)?targeted-run-1-r1$/);
  }
});

test("the four Promotion field groups are the contract's select keys", () => {
  assert.deepEqual([...FIELD_GROUPS], ["availability", "targeting", "rollout", "enabled"]);
});

test("resolution assertions fail loud on the wrong Variant and on ERROR", () => {
  assert.equal(variantName({ variant: LAUNCH_VARIANT }), LAUNCH_VARIANT);
  assert.throws(
    () => assertVariant({ variant: DEFAULT_VARIANT }, LAUNCH_VARIANT, "label"),
    /expected Variant "beta", got "control"/,
  );
  assert.throws(
    () => assertVariant({ variant: LAUNCH_VARIANT, reason: "ERROR" }, LAUNCH_VARIANT, "label"),
    /failed loud with ERROR/,
  );
  assert.throws(() => variantName({}), /unable to map resolution/);
});

// --- Wire contract shapes.

test("promote sends fromEnvironmentId, select, and the inline confirm review", async () => {
  const requests = [];
  const deps = {
    accessToken: "token",
    controlPlaneBaseUrl: "https://cp.example.test",
    runId: "run-1",
    fetch: async (url, init) => {
      requests.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
      return Response.json({ config: config(), diff: {}, approvalRequest: null });
    },
  };

  await promoteFlagConfig(deps, {
    appId: "app-1",
    targetEnvironmentId: "env-prod",
    flagId: "flag-1",
    fromEnvironmentId: "env-dev",
    select: { availability: [DEFAULT_VARIANT, LAUNCH_VARIANT], targeting: true },
    review: { action: "approve_and_apply" },
    label: "primary",
  });

  assert.equal(
    requests[0].url,
    "https://cp.example.test/apps/app-1/envs/env-prod/flags/flag-1/promote",
  );
  assert.deepEqual(requests[0].body, {
    fromEnvironmentId: "env-dev",
    select: { availability: [DEFAULT_VARIANT, LAUNCH_VARIANT], targeting: true },
    review: { action: "approve_and_apply" },
    idempotency_key: "safe-delivery-promote-primary-run-1",
  });
  assert.equal(requests[0].init.headers["idempotency-key"], "safe-delivery-promote-primary-run-1");
});

test("promote omits review entirely when no inline confirm is supplied", async () => {
  let body;
  const deps = {
    accessToken: "token",
    controlPlaneBaseUrl: "https://cp.example.test",
    runId: "run-1",
    fetch: async (_url, init) => {
      body = JSON.parse(init.body);
      return Response.json({ code: "APPROVAL_REVIEW_REQUIRED" }, { status: 409 });
    },
  };
  await promoteFlagConfig(deps, {
    appId: "app-1",
    targetEnvironmentId: "env-prod",
    flagId: "flag-1",
    fromEnvironmentId: "env-dev",
    select: { enabled: true },
    label: "gated",
  });
  assert.ok(!("review" in body), "an ungated promote must not send a review field");
});

test("Flag create and Review carry idempotency in both the body and the header", async () => {
  const requests = [];
  const deps = {
    accessToken: "token",
    controlPlaneBaseUrl: "https://cp.example.test",
    runId: "run-1",
    fetch: async (url, init) => {
      requests.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
      return Response.json({ id: "flag-1", variants: [] });
    },
  };

  await createFlag(deps, "app-1", "safe-delivery-x", [], "primary loop");
  await reviewApprovalRequest(deps, "app-1", "ar-1", "approve_and_apply", "stale");

  assert.equal(requests[0].body.idempotency_key, "safe-delivery-flag-create-safe-delivery-x");
  assert.equal(
    requests[0].init.headers["idempotency-key"],
    "safe-delivery-flag-create-safe-delivery-x",
  );
  assert.equal(
    requests[1].url,
    "https://cp.example.test/apps/app-1/approval-requests/ar-1/reviews",
  );
  assert.deepEqual(requests[1].body, {
    action: "approve_and_apply",
    idempotency_key: "safe-delivery-review-stale-run-1",
  });
});

test("requireOk and requireRefused fail loud in the wrong direction", () => {
  assert.throws(
    () => requireOk({ ok: false, status: 409, body: {} }, "op"),
    /op failed with HTTP 409/,
  );
  assert.throws(() => requireRefused({ ok: true, status: 200 }, "op"), /expected a refusal/);
});

// --- Config contract.

test("the tracer refuses to run without a credential or a deployed commit SHA", () => {
  assert.throws(
    () => readConfig({ SPLITCH_SMOKE_COMMIT_SHA: COMMIT }),
    /SPLITCH_SMOKE_CLIENT_SECRET is required/,
  );
  assert.throws(() => readConfig({ SPLITCH_SMOKE_CLIENT_SECRET: "s" }), /SPLITCH_SMOKE_COMMIT_SHA/);
  assert.throws(
    () => readConfig({ SPLITCH_SMOKE_CLIENT_SECRET: "s", SPLITCH_SMOKE_COMMIT_SHA: "abc" }),
    /SPLITCH_SMOKE_COMMIT_SHA/,
  );
});

test("config defaults to the seeded allow/confirm Environment pair and runs twice", () => {
  const cfg = readConfig({ SPLITCH_SMOKE_CLIENT_SECRET: "s", SPLITCH_SMOKE_COMMIT_SHA: COMMIT });
  assert.equal(cfg.runs, 2);
  assert.equal(cfg.appId, "app_shared_preview_smoke");
  assert.equal(cfg.devEnvironmentId, "env_shared_preview_smoke_dev");
  assert.equal(cfg.prodEnvironmentId, "env_shared_preview_smoke_prod");
  assert.equal(cfg.otherAppEnvironmentId, "env_shared_preview_smoke_other_dev");
  assert.notEqual(cfg.devEnvironmentId, cfg.prodEnvironmentId);
  assert.equal(cfg.evidencePath, "test-results/shared-preview/safe-delivery-evidence.json");
  assert.equal(cfg.stableFlagKey, "shared-preview-smoke");
  assert.equal(cfg.propagationWindowMs, 60_000);
  assert.equal(DANGLING_VARIANT, "holdout");
});

// A NaN `runs` silently skips every run and the tracer "passes" having proven
// nothing; a NaN propagation window makes the poll loop never terminate.
test("a malformed numeric override is refused instead of coerced to NaN", () => {
  const base = { SPLITCH_SMOKE_CLIENT_SECRET: "s", SPLITCH_SMOKE_COMMIT_SHA: COMMIT };
  for (const bad of ["abc", "0", "-1", "NaN", "1e", "Infinity"]) {
    assert.throws(
      () => readConfig({ ...base, SPLITCH_SMOKE_RUNS: bad }),
      /SPLITCH_SMOKE_RUNS must be a positive number/,
      `SPLITCH_SMOKE_RUNS=${bad} was accepted`,
    );
    assert.throws(
      () => readConfig({ ...base, SPLITCH_SMOKE_PROPAGATION_WINDOW_MS: bad }),
      /SPLITCH_SMOKE_PROPAGATION_WINDOW_MS must be a positive number/,
      `SPLITCH_SMOKE_PROPAGATION_WINDOW_MS=${bad} was accepted`,
    );
  }
  assert.equal(readConfig({ ...base, SPLITCH_SMOKE_RUNS: "3" }).runs, 3);
  assert.equal(readConfig({ ...base, SPLITCH_SMOKE_RUNS: "" }).runs, 2);
});

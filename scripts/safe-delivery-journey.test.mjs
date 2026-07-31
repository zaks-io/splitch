import assert from "node:assert/strict";
import test from "node:test";

import {
  APP,
  DEV,
  DEV_KEY,
  fakeControlPlane,
  OTHER,
  PROD,
  PROD_KEY,
} from "./safe-delivery/fake-control-plane.mjs";
import { runSafeDeliveryJourney } from "./safe-delivery/journey.mjs";

function journeyDeps(overrides = {}) {
  return {
    fetch: fakeControlPlane(overrides.server),
    accessToken: "token",
    runId: "run-1-r1",
    controlPlaneBaseUrl: "https://cp.example.test",
    evaluationBaseUrl: "https://edge.example.test",
    appId: APP,
    devEnvironmentId: DEV,
    prodEnvironmentId: PROD,
    otherAppEnvironmentId: OTHER,
    devClientKey: DEV_KEY,
    prodClientKey: PROD_KEY,
    stableFlagKey: "shared-preview-smoke",
    propagationWindowMs: 50,
    sleep: async () => {},
    ...overrides.deps,
  };
}

test("the safe-delivery journey completes every proof in order", async () => {
  const result = await runSafeDeliveryJourney(journeyDeps());

  assert.deepEqual(result.steps, [
    "flags_create",
    "dev_tune_ungated",
    "dev_targeting_keys_verified",
    "prod_baseline_captured",
    "dangling_variant_rejected",
    "unauthorized_promotion_rejected",
    "stale_review_rejected",
    "promotion_diff_matches_preview_and_applied",
    "promotion_applied_selected_field_groups_only",
    "prod_resolution_unchanged_before_enable",
    "enabled_promotion_confirmed",
    "prod_resolution_changed_after_propagation",
    "kill_switch_off_ungated",
  ]);

  assert.deepEqual(result.evidence.danglingVariant.missingVariants, ["holdout"]);
  assert.equal(result.evidence.unauthorizedPromotion.crossAppSource, "VALIDATION_ERROR");
  assert.equal(result.evidence.unauthorizedPromotion.sameEnvironmentSource, "VALIDATION_ERROR");
  assert.equal(result.evidence.staleReview.code, "APPROVAL_REQUEST_STALE");
  assert.deepEqual(result.evidence.selectedFieldGroups, ["availability", "targeting"]);
  assert.equal(result.evidence.killSwitch.ungated, true);
  assert.ok(result.evidence.killSwitch.versionAfter > result.evidence.killSwitch.versionBefore);
  assert.equal(result.evidence.cleanup.orphanedFlags, false);
  assert.equal(result.evidence.cleanup.stableFlagPreserved, true);
});

test("the journey fails loud if kill-switch-off is gated by an Approval Request", async () => {
  await assert.rejects(
    runSafeDeliveryJourney(journeyDeps({ server: { killSwitchApproval: { id: "ar-x" } } })),
    /kill-switch-off minted an Approval Request/,
  );
});

test("transient Flags are deleted even when a proof fails", async () => {
  const deps = journeyDeps({ deps: { otherAppEnvironmentId: PROD } });
  await assert.rejects(runSafeDeliveryJourney(deps));
  const remaining = await (await deps.fetch("https://cp.example.test/apps/app-1/flags", {})).json();
  assert.deepEqual(
    remaining.items.filter((flag) => flag.key.startsWith("safe-delivery-")),
    [],
    "a failed run left transient Flags behind",
  );
});

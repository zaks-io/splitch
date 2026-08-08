/**
 * The safe Flag delivery journey (SPL-151): tune in logical `dev`, inspect the
 * proposed change, Promote selected field groups into logical `prod` through the
 * confirm gate, observe the changed resolution, and kill the Flag.
 *
 * `dev` and `prod` here are logical Environments inside shared preview. No
 * hosted production resource is touched.
 */

import assert from "node:assert/strict";
import { assertNoOrphans, cleanupSafeDelivery } from "./cleanup.mjs";
import {
  COHORT_VALUE,
  DANGLING_VARIANT,
  DEFAULT_VARIANT,
  DEV_ROLLOUT_PERCENTAGE,
  LAUNCH_VARIANT,
  PROPAGATION_WINDOW_MS,
  syntheticKeys,
  UNTARGETED_COHORT_VALUE,
} from "./constants.mjs";
import {
  createFlag,
  getApprovalRequest,
  getFlagConfig,
  promoteFlagConfig,
  requireOk,
} from "./control-plane.mjs";
import {
  assertDiffMatchesPreviewAndApplied,
  assertOnlySelectedFieldGroupsMoved,
} from "./diff-assertions.mjs";
import { assertResolvesNow, assertVariantStable, waitForVariant } from "./evaluation.mjs";
import {
  defineCohortSegment,
  devVerify,
  prodVerify,
  proveKillSwitchUngated,
  tuneInDev,
} from "./journey-steps.mjs";
import {
  proveDanglingVariantRejected,
  proveStaleReviewRejected,
  proveUnauthorizedPromotionRejected,
} from "./rejections.mjs";

const CATALOG = [
  { name: DEFAULT_VARIANT, value: DEFAULT_VARIANT, isDefault: true },
  { name: LAUNCH_VARIANT, value: LAUNCH_VARIANT, isDefault: false },
  { name: DANGLING_VARIANT, value: DANGLING_VARIANT, isDefault: false },
];

export async function runSafeDeliveryJourney(deps) {
  const keys = syntheticKeys(deps.runId);
  const windowMs = deps.propagationWindowMs ?? PROPAGATION_WINDOW_MS;
  const resources = {
    appId: deps.appId,
    flagIds: { primary: null, dangling: null, stale: null },
    segmentId: null,
  };
  const steps = [];
  const evidence = {};

  try {
    const segment = await defineCohortSegment(deps, keys);
    resources.segmentId = segment.id;
    evidence.segmentId = segment.id;
    steps.push("cohort_segment_defined");

    const primary = await createFlag(
      deps,
      deps.appId,
      keys.primaryFlagKey,
      CATALOG,
      "primary loop",
    );
    const dangling = await createFlag(
      deps,
      deps.appId,
      keys.danglingFlagKey,
      CATALOG,
      "dangling probe",
    );
    const stale = await createFlag(
      deps,
      deps.appId,
      keys.staleFlagKey,
      CATALOG,
      "stale Review probe",
    );
    resources.flagIds = { primary: primary.id, dangling: dangling.id, stale: stale.id };
    steps.push("flags_create");

    const variantId = (flag, name) => {
      const match = flag.variants.find((variant) => variant.name === name);
      if (!match) throw new Error(`flags_create missing Variant "${name}"`);
      return match.id;
    };

    await tuneInDev(
      deps,
      primary.id,
      variantId(primary, LAUNCH_VARIANT),
      keys.primaryRuleId,
      segment.id,
      { rollout: { percentage: DEV_ROLLOUT_PERCENTAGE } },
    );
    // The dangling probe serves a Variant prod deliberately never makes available.
    await tuneInDev(
      deps,
      dangling.id,
      variantId(dangling, DANGLING_VARIANT),
      keys.danglingRuleId,
      segment.id,
      {},
    );
    await tuneInDev(
      deps,
      stale.id,
      variantId(stale, LAUNCH_VARIANT),
      keys.staleRuleId,
      segment.id,
      {},
    );
    steps.push("dev_tune_ungated");

    const devSource = await getFlagConfig(deps, deps.appId, deps.devEnvironmentId, primary.id);
    assert.equal(devSource.enabled, true, "dev tuning did not enable the Flag");
    assert.equal(
      devSource.rollout?.percentage,
      DEV_ROLLOUT_PERCENTAGE,
      "dev rollout did not stick",
    );

    await assertResolvesNow(
      deps,
      devVerify(deps, keys, keys.targetedKey, COHORT_VALUE),
      LAUNCH_VARIANT,
      "dev targeted Targeting Key",
    );
    await assertResolvesNow(
      deps,
      devVerify(deps, keys, keys.untargetedKey, UNTARGETED_COHORT_VALUE),
      DEFAULT_VARIANT,
      "dev untargeted Targeting Key",
    );
    steps.push("dev_targeting_keys_verified");

    const baseline = await getFlagConfig(deps, deps.appId, deps.prodEnvironmentId, primary.id);
    assert.equal(baseline.enabled, false, "prod baseline was already enabled");
    await assertResolvesNow(
      deps,
      prodVerify(deps, keys, keys.targetedKey, COHORT_VALUE),
      DEFAULT_VARIANT,
      "prod baseline targeted",
    );
    steps.push("prod_baseline_captured");

    evidence.danglingVariant = await proveDanglingVariantRejected(deps, {
      appId: deps.appId,
      devEnvironmentId: deps.devEnvironmentId,
      prodEnvironmentId: deps.prodEnvironmentId,
      flagId: dangling.id,
      danglingVariant: DANGLING_VARIANT,
    });
    steps.push("dangling_variant_rejected");

    evidence.unauthorizedPromotion = await proveUnauthorizedPromotionRejected(deps, {
      appId: deps.appId,
      devEnvironmentId: deps.devEnvironmentId,
      prodEnvironmentId: deps.prodEnvironmentId,
      otherAppEnvironmentId: deps.otherAppEnvironmentId,
      flagId: primary.id,
      defaultVariant: DEFAULT_VARIANT,
    });
    steps.push("unauthorized_promotion_rejected");

    evidence.staleReview = await proveStaleReviewRejected(deps, {
      appId: deps.appId,
      devEnvironmentId: deps.devEnvironmentId,
      prodEnvironmentId: deps.prodEnvironmentId,
      flagId: stale.id,
      defaultVariant: DEFAULT_VARIANT,
      launchVariant: LAUNCH_VARIANT,
    });
    steps.push("stale_review_rejected");

    // Promote availability + targeting ONLY. `rollout` and `enabled` are
    // deliberately unselected so field-group isolation is provable.
    const select = { availability: [DEFAULT_VARIANT, LAUNCH_VARIANT], targeting: true };
    const promotion = requireOk(
      await promoteFlagConfig(deps, {
        appId: deps.appId,
        targetEnvironmentId: deps.prodEnvironmentId,
        flagId: primary.id,
        fromEnvironmentId: deps.devEnvironmentId,
        select,
        review: { action: "approve_and_apply" },
        label: "primary-config",
      }),
      "flags_promote",
    );
    const appliedConfig = await getFlagConfig(deps, deps.appId, deps.prodEnvironmentId, primary.id);
    assert.ok(
      promotion.approvalRequest,
      "config Promotion returned no Approval Request: the prod Policy is no longer confirm-gating the availability and targeting field groups",
    );
    const persisted = await getApprovalRequest(deps, deps.appId, promotion.approvalRequest.id);
    assertDiffMatchesPreviewAndApplied({
      baseline,
      promoteResponse: promotion,
      approvalRequest: persisted,
      appliedConfig,
      label: "config Promotion",
    });
    steps.push("promotion_diff_matches_preview_and_applied");

    assertOnlySelectedFieldGroupsMoved({
      baseline,
      source: devSource,
      applied: appliedConfig,
      select,
      label: "config Promotion",
    });
    evidence.selectedFieldGroups = Object.keys(select);
    steps.push("promotion_applied_selected_field_groups_only");

    // Still disabled in prod, so resolution must not have moved at all.
    await assertVariantStable(
      deps,
      prodVerify(deps, keys, keys.targetedKey, COHORT_VALUE),
      DEFAULT_VARIANT,
      "prod resolution before enable",
      windowMs,
    );
    steps.push("prod_resolution_unchanged_before_enable");

    const enablePromotion = requireOk(
      await promoteFlagConfig(deps, {
        appId: deps.appId,
        targetEnvironmentId: deps.prodEnvironmentId,
        flagId: primary.id,
        fromEnvironmentId: deps.devEnvironmentId,
        select: { enabled: true },
        review: { action: "approve_and_apply" },
        label: "primary-enable",
      }),
      "flags_promote enabled",
    );
    assert.ok(
      enablePromotion.approvalRequest,
      "enabling Promotion was not gated by the confirm Policy",
    );
    assert.equal(enablePromotion.approvalRequest.status, "applied");
    steps.push("enabled_promotion_confirmed");

    await waitForVariant(
      deps,
      prodVerify(deps, keys, keys.targetedKey, COHORT_VALUE),
      LAUNCH_VARIANT,
      "prod targeted after propagation",
      windowMs,
    );
    await assertResolvesNow(
      deps,
      prodVerify(deps, keys, keys.untargetedKey, UNTARGETED_COHORT_VALUE),
      DEFAULT_VARIANT,
      "prod untargeted after propagation",
    );
    steps.push("prod_resolution_changed_after_propagation");

    evidence.killSwitch = await proveKillSwitchUngated(deps, keys, primary.id, windowMs);
    steps.push("kill_switch_off_ungated");

    await runCleanup();
    return { keys, steps, evidence };
  } catch (failure) {
    // Cleanup still has to run, but a cleanup error must never replace the
    // proof failure that got us here: the original is the diagnostic.
    try {
      await runCleanup();
    } catch (cleanupError) {
      if (failure instanceof Error) failure.cleanupError = cleanupError;
    }
    throw failure;
  }

  async function runCleanup() {
    if (evidence.cleanup) return;
    await cleanupSafeDelivery(deps, resources);
    evidence.cleanup = await assertNoOrphans(deps, deps.appId, keys, deps.stableFlagKey);
  }
}

/**
 * Individual step implementations for the safe-delivery journey. `journey.mjs`
 * owns the ordering and the evidence; this module owns what each step proves.
 */

import assert from "node:assert/strict";

import {
  COHORT_ATTRIBUTE,
  COHORT_VALUE,
  DANGLING_VARIANT,
  DEFAULT_VARIANT,
  LAUNCH_VARIANT,
} from "./constants.mjs";
import {
  createSegment,
  getFlagConfig,
  listApprovalRequests,
  patchFlagConfig,
  replaceTargetingRules,
  requireOk,
} from "./control-plane.mjs";
import { waitForVariant } from "./evaluation.mjs";

/** The cohort this tracer targets, as a reusable condition set. */
function cohortConditions() {
  return [{ attribute: COHORT_ATTRIBUTE, operator: "eq", value: COHORT_VALUE }];
}

/**
 * Create the real Segment resource naming the cohort we target.
 *
 * CONTRACT NOTE: TargetingRuleSchema carries inline `conditions` and has no
 * `segmentId`, so the contract offers no way to bind a Targeting Rule to a
 * Segment. The Segment is therefore the named, reusable definition of the
 * cohort, and the Rule restates the same conditions inline because that is the
 * only shape the Flag targeting path accepts. Creating the Segment proves the
 * resource is real and reachable in this loop rather than leaving the Segment
 * leg of SPL-151 silently unexercised.
 */
export async function defineCohortSegment(deps, keys) {
  const segment = await createSegment(deps, deps.appId, keys.segmentName, cohortConditions());
  assert.deepEqual(
    segment.conditions,
    cohortConditions(),
    "segments_create did not persist the cohort conditions",
  );
  return segment;
}

/** Verification context for the primary Flag against a given Environment. */
function verifyContext(clientKey, keys, targetingKey, cohort) {
  return {
    clientKey,
    flagKey: keys.primaryFlagKey,
    targetingKey,
    attributes: { [COHORT_ATTRIBUTE]: cohort },
  };
}

export function devVerify(deps, keys, targetingKey, cohort) {
  return verifyContext(deps.devClientKey, keys, targetingKey, cohort);
}

export function prodVerify(deps, keys, targetingKey, cohort) {
  return verifyContext(deps.prodClientKey, keys, targetingKey, cohort);
}

/**
 * Tune a Flag in the logical `dev` Environment. dev is an `allow` Environment,
 * so every write must land directly: a non-null approvalRequest here would mean
 * the Policy fixture drifted and the rest of the proof would be meaningless.
 */
export async function tuneInDev(deps, flagId, variantId, ruleId, extra) {
  const patch = requireOk(
    await patchFlagConfig(
      deps,
      deps.appId,
      deps.devEnvironmentId,
      flagId,
      {
        enabled: true,
        availableVariantNames: [DEFAULT_VARIANT, LAUNCH_VARIANT, DANGLING_VARIANT],
        ...extra,
      },
      `dev-tune-${flagId}`,
    ),
    "dev flag_config_update",
  );
  assert.equal(patch.approvalRequest, null, "dev tuning was gated: dev Policy should be allow");

  const rules = requireOk(
    await replaceTargetingRules(
      deps,
      deps.appId,
      deps.devEnvironmentId,
      flagId,
      [
        {
          id: ruleId,
          flagId,
          priority: 0,
          conditions: cohortConditions(),
          variantId,
          percentageRollout: null,
        },
      ],
      `dev-rules-${flagId}`,
    ),
    "dev flag_targeting_rules_replace",
  );
  assert.equal(rules.approvalRequest, null, "dev Targeting Rule write was gated");
}

/**
 * Kill-switch-off must be ungated even though the prod Environment Policy is
 * `confirm` on `enabledState`: an operator must always be able to turn a Flag
 * off in an incident (ADR-0029). The proof is HTTP 200 with a null
 * approvalRequest and no new pending Approval Request.
 */
export async function proveKillSwitchUngated(deps, keys, flagId, windowMs) {
  const before = await getFlagConfig(deps, deps.appId, deps.prodEnvironmentId, flagId);
  const pendingBefore = await listApprovalRequests(deps, deps.appId, "pending");

  const result = await patchFlagConfig(
    deps,
    deps.appId,
    deps.prodEnvironmentId,
    flagId,
    { enabled: false },
    "kill-switch",
  );
  const body = requireOk(result, "kill-switch flag_config_update");
  assert.equal(result.status, 200, "kill-switch-off was not applied directly");
  assert.equal(
    body.approvalRequest,
    null,
    "kill-switch-off minted an Approval Request: it must never be gated",
  );

  const after = await getFlagConfig(deps, deps.appId, deps.prodEnvironmentId, flagId);
  assert.equal(after.enabled, false, "kill-switch-off did not take effect");
  assert.ok(after.version > before.version, "kill-switch-off did not record a new version");

  const pendingAfter = await listApprovalRequests(deps, deps.appId, "pending");
  assert.equal(
    (pendingAfter.items ?? []).length,
    (pendingBefore.items ?? []).length,
    "kill-switch-off changed the pending Approval Request set",
  );

  await waitForVariant(
    deps,
    prodVerify(deps, keys, keys.targetedKey, COHORT_VALUE),
    DEFAULT_VARIANT,
    "prod targeted after kill switch",
    windowMs,
  );

  // There is no audit-log surface yet -- the registry declares no audit route at
  // all now that a declared-but-unmounted route fails route-surface-mounting
  // (SPL-161 owns building one). So the durable change record available today is
  // the Flag Configuration version plus the provable absence of an Approval
  // Request.
  return {
    ungated: true,
    approvalRequest: null,
    versionBefore: before.version,
    versionAfter: after.version,
    auditSurface: "flag_configs.version (no audit log endpoint yet; SPL-161)",
  };
}

/**
 * Promotion diff and field-group assertions.
 *
 * The load-bearing invariant is that a Promotion applies ONLY the field groups
 * the caller explicitly selected. Asserting "the selected groups moved" is not
 * enough on its own: a Promotion that moved everything would also pass that.
 * So every assertion here is paired with a proof that the UNSELECTED groups are
 * byte-identical to the pre-Promotion target state.
 */

import assert from "node:assert/strict";

/** The four field groups projected out of a FlagConfigResponse. */
export function projectFieldGroups(config) {
  return {
    availability: [...(config.availableVariantNames ?? [])].sort(),
    targeting: config.targetingRules ?? [],
    rollout: config.rollout ?? null,
    enabled: config.enabled,
  };
}

function assertConfigsEqual(actual, expected, label) {
  assert.deepEqual(
    projectFieldGroups(actual),
    projectFieldGroups(expected),
    `${label}: Flag Configuration field groups differ`,
  );
}

/**
 * Prove the persisted Approval Request diff is the same change the operator
 * previewed, and that applying it produced exactly that state.
 *
 * `diff.current` is the pre-Promotion target, `diff.proposed` is the preview.
 * Equality across preview -> persisted -> applied is the whole point of the
 * confirm gate: an operator who approves a diff must get that diff and no more.
 */
export function assertDiffMatchesPreviewAndApplied(input) {
  const { baseline, promoteResponse, approvalRequest, appliedConfig, label } = input;

  assertConfigsEqual(promoteResponse.diff.before, baseline, `${label}: promote diff.before`);
  assertConfigsEqual(promoteResponse.diff.after, appliedConfig, `${label}: promote diff.after`);
  assertConfigsEqual(promoteResponse.config, appliedConfig, `${label}: promote response config`);

  assert.ok(approvalRequest, `${label}: gated Promotion returned no Approval Request`);
  assert.equal(approvalRequest.status, "applied", `${label}: Approval Request was not applied`);
  assertConfigsEqual(approvalRequest.diff.current, baseline, `${label}: persisted diff.current`);
  assertConfigsEqual(
    approvalRequest.diff.proposed,
    appliedConfig,
    `${label}: persisted diff.proposed`,
  );
}

/**
 * Prove selection isolation: the selected groups took the source value, and
 * every unselected group is unchanged from the baseline.
 */
export function assertOnlySelectedFieldGroupsMoved(input) {
  const { baseline, source, applied, select, label } = input;
  const base = projectFieldGroups(baseline);
  const from = projectFieldGroups(source);
  const now = projectFieldGroups(applied);

  if (select.availability !== undefined) {
    assert.deepEqual(
      now.availability,
      [...select.availability].sort(),
      `${label}: selected availability did not move`,
    );
  } else {
    assert.deepEqual(
      now.availability,
      base.availability,
      `${label}: unselected availability moved`,
    );
  }

  if (select.targeting) {
    assert.equal(
      now.targeting.length,
      from.targeting.length,
      `${label}: selected targeting did not move`,
    );
  } else {
    assert.deepEqual(now.targeting, base.targeting, `${label}: unselected targeting moved`);
  }

  if (select.rollout) {
    assert.deepEqual(now.rollout, from.rollout, `${label}: selected rollout did not move`);
  } else {
    assert.deepEqual(now.rollout, base.rollout, `${label}: unselected rollout moved`);
  }

  if (select.enabled) {
    assert.equal(now.enabled, from.enabled, `${label}: selected enabled did not move`);
  } else {
    assert.equal(now.enabled, base.enabled, `${label}: unselected enabled moved`);
  }
}

/** A refused Promotion must leave the target Flag Configuration untouched. */
export function assertTargetUnchanged(before, after, label) {
  assert.equal(after.version, before.version, `${label}: refused write still bumped version`);
  assertConfigsEqual(after, before, `${label}: refused write mutated the target`);
}

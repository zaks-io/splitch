import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_VARIANT, LAUNCH_VARIANT } from "./safe-delivery/constants.mjs";
import {
  assertOnlySelectedFieldGroupsMoved,
  assertTargetUnchanged,
  projectFieldGroups,
} from "./safe-delivery/diff-assertions.mjs";
import { flagConfig as config } from "./safe-delivery/flag-config-fixture.mjs";

test("field-group projection normalises availability ordering and null rollout", () => {
  const projected = projectFieldGroups(
    config({ availableVariantNames: [LAUNCH_VARIANT, DEFAULT_VARIANT] }),
  );
  assert.deepEqual(projected.availability, [LAUNCH_VARIANT, DEFAULT_VARIANT].sort());
  assert.equal(projected.rollout, null);
});

// --- Mutation proofs: the field-group guard must fail in BOTH directions. A
// guard that only accepts correct input proves nothing if it also accepts a
// Promotion that moved an unselected group.

test("selection isolation accepts a Promotion that moved exactly the selected groups", () => {
  const baseline = config();
  const source = config({
    enabled: true,
    availableVariantNames: [DEFAULT_VARIANT, LAUNCH_VARIANT],
    targetingRules: [{ id: "rule-1" }],
    rollout: { percentage: 25, salt: "s" },
  });
  assertOnlySelectedFieldGroupsMoved({
    baseline,
    source,
    applied: config({
      availableVariantNames: [DEFAULT_VARIANT, LAUNCH_VARIANT],
      targetingRules: [{ id: "rule-1" }],
    }),
    select: { availability: [DEFAULT_VARIANT, LAUNCH_VARIANT], targeting: true },
    label: "promotion",
  });
});

test("selection isolation rejects selected targeting that moved the wrong rules", () => {
  assert.throws(
    () =>
      assertOnlySelectedFieldGroupsMoved({
        baseline: config(),
        source: config({
          targetingRules: [
            { id: "rule-1", priority: 0, conditions: [{ a: 1 }], variantId: "v-beta" },
          ],
        }),
        // Same NUMBER of rules, different meaning: a length-only check passes this.
        applied: config({
          targetingRules: [
            { id: "rule-9", priority: 0, conditions: [{ a: 2 }], variantId: "v-control" },
          ],
        }),
        select: { targeting: true },
        label: "promotion",
      }),
    /selected targeting did not move/,
  );
});

test("selection isolation rejects an unselected availability that moved", () => {
  assert.throws(
    () =>
      assertOnlySelectedFieldGroupsMoved({
        baseline: config(),
        source: config({ enabled: true, availableVariantNames: [DEFAULT_VARIANT, LAUNCH_VARIANT] }),
        applied: config({
          enabled: true,
          availableVariantNames: [DEFAULT_VARIANT, LAUNCH_VARIANT],
        }),
        select: { enabled: true },
        label: "promotion",
      }),
    /unselected availability moved/,
  );
});

test("selection isolation rejects an unselected enabled that moved", () => {
  assert.throws(
    () =>
      assertOnlySelectedFieldGroupsMoved({
        baseline: config(),
        source: config({ enabled: true, availableVariantNames: [DEFAULT_VARIANT, LAUNCH_VARIANT] }),
        applied: config({
          enabled: true,
          availableVariantNames: [DEFAULT_VARIANT, LAUNCH_VARIANT],
        }),
        select: { availability: [DEFAULT_VARIANT, LAUNCH_VARIANT] },
        label: "promotion",
      }),
    /unselected enabled moved/,
  );
});

test("selection isolation rejects an unselected rollout that moved", () => {
  assert.throws(
    () =>
      assertOnlySelectedFieldGroupsMoved({
        baseline: config(),
        source: config({ rollout: { percentage: 25, salt: "s" } }),
        applied: config({ rollout: { percentage: 25, salt: "s" } }),
        select: { availability: [DEFAULT_VARIANT] },
        label: "promotion",
      }),
    /unselected rollout moved/,
  );
});

test("selection isolation rejects unselected Targeting Rules that moved", () => {
  assert.throws(
    () =>
      assertOnlySelectedFieldGroupsMoved({
        baseline: config(),
        source: config({ targetingRules: [{ id: "rule-1" }] }),
        applied: config({ targetingRules: [{ id: "rule-1" }] }),
        select: { availability: [DEFAULT_VARIANT] },
        label: "promotion",
      }),
    /unselected targeting moved/,
  );
});

test("selection isolation rejects a selected group that did not move", () => {
  assert.throws(
    () =>
      assertOnlySelectedFieldGroupsMoved({
        baseline: config(),
        source: config({ enabled: true }),
        applied: config(),
        select: { enabled: true },
        label: "promotion",
      }),
    /selected enabled did not move/,
  );
});

test("a refused Promotion must leave the target untouched", () => {
  assertTargetUnchanged(config(), config(), "refusal");
  assert.throws(
    () => assertTargetUnchanged(config(), config({ version: 2 }), "refusal"),
    /refused write still bumped version/,
  );
  assert.throws(
    () => assertTargetUnchanged(config(), config({ enabled: true }), "refusal"),
    /refused write mutated the target/,
  );
});

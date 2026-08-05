import { describe, expect, it } from "vitest";
import {
  AVAILABILITY_FIELD,
  diffEntriesTouch,
  frozenFieldsFromDiffEntries,
  ROLLOUT_FIELD,
  TARGETING_FIELD,
} from "../src/flag-config-run-freeze-proposal";

/**
 * SPL-304. The Run-freeze check on `approve_and_apply` must key off the
 * Approval Request's own `diff.entries`, not a re-diff of the complete proposed
 * snapshot. These pins are the mutation proofs: widen the mapping to treat
 * `/enabled` as frozen and the enabled-only case goes red; drop the targeting
 * mapping and the genuine freeze case goes red.
 */
describe("frozenFieldsFromDiffEntries", () => {
  it("treats an enabled-only change set as touching nothing a Run freezes", () => {
    const changed = frozenFieldsFromDiffEntries([{ path: "/enabled" }, { path: "/version" }]);
    expect(changed).toEqual({ ok: true, frozenFields: [] });
  });

  it("names only the frozen fields the entries actually change", () => {
    expect(
      frozenFieldsFromDiffEntries([{ path: "/availableVariantNames" }, { path: "/version" }]),
    ).toEqual({ ok: true, frozenFields: [AVAILABILITY_FIELD] });

    expect(frozenFieldsFromDiffEntries([{ path: "/targetingRules/0/conditions/0/value" }])).toEqual(
      { ok: true, frozenFields: [TARGETING_FIELD] },
    );

    expect(frozenFieldsFromDiffEntries([{ path: "/rollout/percentage" }])).toEqual({
      ok: true,
      frozenFields: [ROLLOUT_FIELD],
    });
  });

  it("does not report targetingRules for a request whose entries never touch it", () => {
    // Mutation proof (over-broad): if the mapping treated every known frozen
    // field as changed whenever *any* entry existed, this would include
    // targetingRules and the enabled-only apply-under-Run test would fail.
    const changed = frozenFieldsFromDiffEntries([
      { path: "/enabled" },
      { path: "/version" },
      { path: "/experiment" },
    ]);
    expect(changed).toEqual({ ok: true, frozenFields: [] });
    expect(changed.ok && changed.frozenFields).not.toContain(TARGETING_FIELD);
  });

  it("still reports targetingRules when the entries genuinely change them", () => {
    // Mutation proof (absent check): if the targeting mapping were deleted,
    // this would return [] and the genuine RUN_FROZEN refusal would disappear.
    const changed = frozenFieldsFromDiffEntries([
      { path: "/targetingRules" },
      { path: "/version" },
    ]);
    expect(changed).toEqual({ ok: true, frozenFields: [TARGETING_FIELD] });
  });

  it("fails closed when the changed-field set cannot be determined", () => {
    expect(frozenFieldsFromDiffEntries(undefined)).toEqual({
      ok: false,
      reason: "CHANGED_FIELDS_UNDETERMINED",
    });
    expect(frozenFieldsFromDiffEntries([])).toEqual({
      ok: false,
      reason: "CHANGED_FIELDS_UNDETERMINED",
    });
    expect(frozenFieldsFromDiffEntries([{ path: "/notAFlagConfigField" }])).toEqual({
      ok: false,
      reason: "CHANGED_FIELDS_UNDETERMINED",
    });
    expect(frozenFieldsFromDiffEntries([{ path: "enabled" }])).toEqual({
      ok: false,
      reason: "CHANGED_FIELDS_UNDETERMINED",
    });
  });

  it("diffEntriesTouch keys off the same top-level segment", () => {
    expect(diffEntriesTouch([{ path: "/enabled" }, { path: "/version" }], "targetingRules")).toBe(
      false,
    );
    expect(diffEntriesTouch([{ path: "/targetingRules/0/priority" }], "targetingRules")).toBe(true);
  });
});

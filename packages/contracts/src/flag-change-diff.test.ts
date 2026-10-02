import { describe, expect, it } from "vitest";
import { parseFlagChangeDiff } from "./flag-change-diff";
import { renderFlagChangeUnifiedDiff } from "./flag-change-unified-diff";

/**
 * These fixtures are the trigger payloads from 0026_flag_change_log.sql, not
 * reconstructed Flag Configuration. A test that invented a field the trigger
 * never wrote would hide a silent default.
 */

describe("parseFlagChangeDiff from stored records", () => {
  it("projects a targeting rule update as stored [old, new] pairs", () => {
    const diff = parseFlagChangeDiff(
      JSON.stringify({
        ruleId: "rule_a",
        priority: [1, 2],
        conditions: ["[]", '[{"attribute":"country"}]'],
        variantId: [null, "var_on"],
        percentageRollout: [null, null],
      }),
      "updated",
    );
    expect(diff.before).toEqual({
      priority: 1,
      conditions: "[]",
      variantId: null,
      percentageRollout: null,
    });
    expect(diff.after).toEqual({
      ruleId: "rule_a",
      priority: 2,
      conditions: '[{"attribute":"country"}]',
      variantId: "var_on",
      percentageRollout: null,
    });
    expect(diff.fields).toEqual(
      expect.arrayContaining([
        { name: "priority", before: 1, after: 2 },
        { name: "conditions", before: "[]", after: '[{"attribute":"country"}]' },
      ]),
    );
  });

  it("projects a variant value change from the stored pair", () => {
    const diff = parseFlagChangeDiff(
      JSON.stringify({ variant: ["control", "control"], value: ['"control"', '"changed"'] }),
      "updated",
    );
    expect(diff.before).toEqual({ variant: "control", value: '"control"' });
    expect(diff.after).toEqual({ variant: "control", value: '"changed"' });
  });

  it("projects a kill switch toggle from the stored enabled pair", () => {
    const diff = parseFlagChangeDiff(
      JSON.stringify({
        enabled: [0, 1],
        rollout: [null, null],
        defaultVariantId: [null, null],
        availableVariantNames: ["[]", "[]"],
      }),
      "updated",
    );
    expect(diff.before?.enabled).toBe(0);
    expect(diff.after?.enabled).toBe(1);
    expect(diff.fields.find((field) => field.name === "enabled")).toEqual({
      name: "enabled",
      before: 0,
      after: 1,
    });
  });

  it("treats added/removed lifecycle records as one-sided", () => {
    expect(
      parseFlagChangeDiff(JSON.stringify({ variant: "on", change: "added" }), "updated"),
    ).toEqual({
      before: null,
      after: { variant: "on" },
      fields: [{ name: "variant", after: "on" }],
    });
    expect(
      parseFlagChangeDiff(JSON.stringify({ ruleId: "rule_a", change: "removed" }), "updated"),
    ).toEqual({
      before: { ruleId: "rule_a" },
      after: null,
      fields: [{ name: "ruleId", before: "rule_a" }],
    });
  });

  it("refuses invented JSON rather than substituting an empty diff", () => {
    expect(() => parseFlagChangeDiff("{", "updated")).toThrow(/not valid JSON/);
    expect(() => parseFlagChangeDiff("[]", "updated")).toThrow(/JSON object or null/);
  });
});

describe("renderFlagChangeUnifiedDiff", () => {
  it("emits only stored field changes", () => {
    const text = renderFlagChangeUnifiedDiff([
      {
        seq: 12,
        flagKey: "checkout",
        environmentId: "env_prod",
        action: "updated",
        targetType: "flag_config",
        changedAt: "2026-08-25T00:00:00.000Z",
        diff: parseFlagChangeDiff(
          JSON.stringify({ enabled: [0, 1], rollout: [null, null] }),
          "updated",
        ),
      },
    ]);
    expect(text).toContain("diff --git a/flag-changes/checkout@env_prod/seq-12");
    expect(text).toContain("-enabled: 0");
    expect(text).toContain("+enabled: 1");
    expect(text).not.toContain("availableVariantNames");
  });
});

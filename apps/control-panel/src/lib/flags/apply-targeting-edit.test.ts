import type { TargetingRuleInput } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { applyTargetingEdit } from "./apply-targeting-edit";
import { addTargetingRuleIntent, removeTargetingRuleIntent } from "./flag-edit-intent";

const existing: TargetingRuleInput = {
  id: "rule_existing",
  flagId: "flag_1",
  priority: 4,
  conditions: [{ attribute: "country", operator: "eq", value: "US" }],
  variantId: "variant_control",
  percentageRollout: { percentage: 20, salt: "persisted-salt" },
};

describe("Targeting Rule edits", () => {
  it("preserves existing rules and adds the next priority without minting a salt", () => {
    const intent = addTargetingRuleIntent(
      {
        attribute: "plan",
        value: "pro",
        segmentId: "segment_paid",
        variantId: "variant_treatment",
        percentage: 35,
      },
      "rule_new",
    );
    expect(applyTargetingEdit([existing], intent.edit, "flag_1")).toEqual([
      existing,
      {
        id: "rule_new",
        flagId: "flag_1",
        priority: 5,
        conditions: [{ attribute: "plan", operator: "eq", value: "pro" }],
        segmentId: "segment_paid",
        variantId: "variant_treatment",
        percentageRollout: { percentage: 35 },
      },
    ]);
  });

  it("removes only the named rule", () => {
    const second = { ...existing, id: "rule_second", priority: 5 };
    const intent = removeTargetingRuleIntent(existing.id);
    expect(applyTargetingEdit([existing, second], intent.edit, "flag_1")).toEqual([second]);
  });
});

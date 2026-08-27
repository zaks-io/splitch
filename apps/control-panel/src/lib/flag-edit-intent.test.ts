import { describe, expect, it } from "vitest";
import { addTargetingRuleIntent } from "./flag-edit-intent";

describe("Targeting Rule edit intent", () => {
  it("carries an optional percentage without inventing a bucketing salt", () => {
    expect(
      addTargetingRuleIntent(
        {
          attribute: "plan",
          value: "pro",
          variantId: "var_treatment",
          percentage: 25,
        },
        "rule_percentage",
      ),
    ).toEqual({
      kind: "targeting",
      summary: "Add a Targeting Rule",
      edit: {
        kind: "add",
        ruleId: "rule_percentage",
        condition: { attribute: "plan", operator: "eq", value: "pro" },
        variantId: "var_treatment",
        percentage: 25,
      },
    });
  });
});

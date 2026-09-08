import type { TargetingRuleInput } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { parseConclusionTargetingRules } from "./experiment-conclusion-targeting";

const existing: TargetingRuleInput = {
  id: "rule_existing",
  flagId: "flag_1",
  priority: 4,
  conditions: [{ attribute: "country", operator: "eq", value: "US" }],
  variantId: "variant_control",
  percentageRollout: { percentage: 20, salt: "persisted-salt" },
};

describe("Conclusion Targeting Rules", () => {
  it("parses the full authoring contract and preserves existing salts", () => {
    expect(parseConclusionTargetingRules(JSON.stringify([existing]))).toEqual([existing]);
  });
});

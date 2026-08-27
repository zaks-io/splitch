import { describe, expect, it } from "vitest";
import {
  variantTargetingRuleReferenceDetails,
  variantTargetingRuleReferenceError,
  variantTargetingRuleReferenceMessage,
} from "./flag-definition-errors";

const REFUSAL = {
  variantName: "treatment",
  targetingRules: [
    { id: "rule_dev", environmentId: "env_dev" },
    { id: "rule_prod", environmentId: "env_prod" },
  ],
};

describe("Variant Targeting Rule delete refusal", () => {
  it("names every referencing rule in details", () => {
    expect(variantTargetingRuleReferenceDetails(REFUSAL)).toEqual({
      resourceType: "variant",
      resourceId: "treatment",
      childType: "flag-targeting-rules",
      childCount: 2,
      attemptedOp: "DELETE_VARIANT",
      targetingRuleIds: ["rule_dev", "rule_prod"],
      targetingRules: REFUSAL.targetingRules,
    });
  });

  it("names the rule IDs in the message so a caller can act", () => {
    expect(variantTargetingRuleReferenceMessage(REFUSAL)).toContain("rule_dev, rule_prod");
  });

  it("renders RESOURCE_NOT_EMPTY on the direct route", async () => {
    const response = variantTargetingRuleReferenceError(REFUSAL, "req_spl207");
    const body = (await response.json()) as {
      code: string;
      details: { targetingRuleIds: string[] };
    };

    expect(response.status).toBe(409);
    expect(body.code).toBe("RESOURCE_NOT_EMPTY");
    expect(body.details.targetingRuleIds).toEqual(["rule_dev", "rule_prod"]);
  });
});

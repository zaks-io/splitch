import { describe, expect, it } from "vitest";
import {
  ReplaceTargetingRulesRequestSchema,
  TARGETING_RULE_ID_DUPLICATE_MESSAGE,
  targetingRuleDuplicateIdIssues,
} from "./route-shapes";

const rule = {
  id: "rule-admin",
  flagId: "flag_checkout",
  priority: 0,
  conditions: [{ attribute: "plan", operator: "eq", value: "pro" }],
  variantId: "var_treatment",
};

describe("ReplaceTargetingRulesRequestSchema identity", () => {
  it("accepts a unique Targeting Rule list", () => {
    expect(
      ReplaceTargetingRulesRequestSchema.safeParse({
        targetingRules: [rule, { ...rule, id: "rule-beta", priority: 1 }],
        idempotency_key: "idem_ok",
      }).success,
    ).toBe(true);
  });

  it("accepts a percentage without requiring a caller-minted salt", () => {
    expect(
      ReplaceTargetingRulesRequestSchema.safeParse({
        targetingRules: [{ ...rule, percentageRollout: { percentage: 25 } }],
        idempotency_key: "idem_percentage",
      }).success,
    ).toBe(true);
  });

  it("keeps a persisted percentage rollout round-trippable", () => {
    expect(
      ReplaceTargetingRulesRequestSchema.safeParse({
        targetingRules: [{ ...rule, percentageRollout: { percentage: 25, salt: "server-minted" } }],
        idempotency_key: "idem_round_trip",
      }).success,
    ).toBe(true);
  });

  it("reports each repeated id at targetingRules.N.id", () => {
    const parsed = ReplaceTargetingRulesRequestSchema.safeParse({
      targetingRules: [rule, { ...rule, priority: 1 }, { ...rule, id: "rule-beta", priority: 2 }],
      idempotency_key: "idem_dupe",
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error("expected duplicate ids to fail");
    expect(parsed.error.issues).toEqual([
      expect.objectContaining({
        path: ["targetingRules", 1, "id"],
        message: TARGETING_RULE_ID_DUPLICATE_MESSAGE,
      }),
    ]);
  });

  it("names every later duplicate in targetingRuleDuplicateIdIssues", () => {
    expect(
      targetingRuleDuplicateIdIssues([
        { id: "rule-admin" },
        { id: "rule-beta" },
        { id: "rule-admin" },
        { id: "rule-admin" },
      ]),
    ).toEqual([
      { path: ["targetingRules", 2, "id"], message: TARGETING_RULE_ID_DUPLICATE_MESSAGE },
      { path: ["targetingRules", 3, "id"], message: TARGETING_RULE_ID_DUPLICATE_MESSAGE },
    ]);
  });
});

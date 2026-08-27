import type { TargetingRule } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { targetingRulePersistFailure } from "./config-store-targeting-rules";

const RULES: TargetingRule[] = [
  {
    id: "rule_admin",
    flagId: "flag_checkout",
    priority: 0,
    conditions: [{ attribute: "plan", operator: "eq", value: "pro" }],
    variantId: "var_treatment",
  },
];

describe("targetingRulePersistFailure", () => {
  it("maps a missing Variant at persist time to VARIANT_NOT_AVAILABLE", () => {
    expect(
      targetingRulePersistFailure(
        { ok: false, reason: "missing_variant", missingVariantIds: ["var_treatment"] },
        RULES,
        "FLAG_NOT_FOUND",
      ),
    ).toEqual({
      ok: false,
      reason: "VARIANT_NOT_AVAILABLE",
      missingVariants: ["var_treatment"],
    });
  });

  it("keeps uniqueness races typed", () => {
    expect(
      targetingRulePersistFailure({ ok: false, reason: "id_conflict" }, RULES, "FLAG_NOT_FOUND"),
    ).toEqual({
      ok: false,
      reason: "TARGETING_RULE_ID_CONFLICT",
      targetingRules: RULES,
    });
  });
});

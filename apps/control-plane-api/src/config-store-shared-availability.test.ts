import { describe, expect, it } from "vitest";
import { missingRuleVariantNames } from "./config-store-shared";

describe("Targeting Rule Variant availability", () => {
  const variants = [
    { id: "var_control", name: "control" },
    { id: "var_treatment", name: "treatment" },
  ];
  const rules = [{ variantId: "var_treatment" }];

  it("treats an empty availability list as never narrowed", () => {
    expect(missingRuleVariantNames(rules, variants, [])).toEqual([]);
  });

  it("still rejects a rule outside an explicitly narrowed catalog", () => {
    expect(missingRuleVariantNames(rules, variants, ["control"])).toEqual(["treatment"]);
  });
});

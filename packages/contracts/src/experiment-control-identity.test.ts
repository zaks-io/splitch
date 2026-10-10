import { describe, expect, it } from "vitest";
import {
  resolveAnalysisControlIntegrity,
  resolveFrozenControlIdentity,
} from "./experiment-control-identity";

const variantSet = JSON.stringify([
  { id: "variant_a", name: "control", value: false },
  { id: "variant_b", name: "treatment", value: true },
]);

describe("resolveFrozenControlIdentity", () => {
  it("names the Control by the frozen id, not by the name 'control'", () => {
    const control = resolveFrozenControlIdentity("variant_b", variantSet);
    expect(control).toEqual({ state: "frozen", variantId: "variant_b", variant: "treatment" });
  });

  it("refuses a Control the Run never froze instead of picking an arm", () => {
    const control = resolveFrozenControlIdentity("variant_from_a_later_edit", variantSet);
    expect(control).toEqual({
      state: "unresolvable",
      variantId: "variant_from_a_later_edit",
      reason: "absent_from_frozen_variant_set",
      frozenVariantNames: ["control", "treatment"],
    });
  });

  it.each([
    ["not json", "{{"],
    ["not an array", '{"id":"variant_a","name":"control"}'],
    ["missing the fields it needs", '[{"id":"variant_a"}]'],
  ])("refuses a frozen Variant set that is %s", (_case, json) => {
    const control = resolveFrozenControlIdentity("variant_a", json);
    expect(control).toEqual({
      state: "unresolvable",
      variantId: "variant_a",
      reason: "unreadable_frozen_variant_set",
      frozenVariantNames: [],
    });
  });
});

describe("resolveAnalysisControlIntegrity", () => {
  const frozen = { state: "frozen" as const, variantId: "variant_a", variant: "control" };

  it("keeps the frozen identity when Analysis agrees", () => {
    expect(resolveAnalysisControlIntegrity(frozen, "control")).toEqual(frozen);
  });

  it("names both Controls when Analysis disagrees", () => {
    expect(resolveAnalysisControlIntegrity(frozen, "legacy_checkout")).toEqual({
      state: "disagreement",
      variantId: "variant_a",
      variant: "control",
      analysisVariant: "legacy_checkout",
    });
  });

  it("adds the Analysis Control to an unresolvable frozen Control", () => {
    const unresolvable = {
      state: "unresolvable" as const,
      variantId: "variant_missing",
      reason: "absent_from_frozen_variant_set" as const,
      frozenVariantNames: ["control", "treatment"],
    };

    expect(resolveAnalysisControlIntegrity(unresolvable, "control")).toEqual({
      ...unresolvable,
      analysisVariant: "control",
    });
  });

  it("fails loudly when the Analysis Control name is missing", () => {
    const unresolvable = {
      state: "unresolvable" as const,
      variantId: "variant_missing",
      reason: "absent_from_frozen_variant_set" as const,
      frozenVariantNames: ["control", "treatment"],
    };

    expect(() => resolveAnalysisControlIntegrity(unresolvable, "")).toThrow(
      "Analysis Control name is missing from resolveAnalysisControlIntegrity input",
    );
  });
});

import { describe, expect, it } from "vitest";
import { DecisionFamilyMemberSchema, DimensionInputSchema } from "./stats-input-contract.js";

const decisionFamilyMember = {
  metric_id: "metric_1",
  variant: "treatment",
};

function omitField(input: Record<string, unknown>, field: string): Record<string, unknown> {
  const copy = { ...input };
  delete copy[field];
  return copy;
}

describe("DecisionFamilyMemberSchema", () => {
  it.each(["metric_id", "variant"])("rejects a missing %s field", (field) => {
    expect(
      DecisionFamilyMemberSchema.safeParse(omitField(decisionFamilyMember, field)).success,
    ).toBe(false);
  });

  it("keeps Dimension fields optional and nullable", () => {
    expect(DecisionFamilyMemberSchema.parse(decisionFamilyMember).dimension_id).toBeUndefined();
    expect(
      DecisionFamilyMemberSchema.parse({
        ...decisionFamilyMember,
        dimension_id: null,
        dimension_value: null,
      }).dimension_value,
    ).toBeNull();
  });
});

describe("DimensionInputSchema", () => {
  const dimensionInput = {
    dimension_id: "country",
    class: "primary",
    values: ["US", "CA"],
  };

  it.each(["dimension_id", "class"])("rejects a missing %s field", (field) => {
    expect(DimensionInputSchema.safeParse(omitField(dimensionInput, field)).success).toBe(false);
  });

  it("allows omitted values for observed Secondary Dimensions", () => {
    expect(
      DimensionInputSchema.parse({
        dimension_id: "plan",
        class: "secondary",
      }).values,
    ).toBeUndefined();
  });
});

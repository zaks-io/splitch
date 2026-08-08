import { describe, expect, it } from "vitest";
import {
  ConditionOperatorSchema,
  ConditionSchema,
  conditionOperators,
  PercentageRolloutSchema,
  SegmentSchema,
} from "./leaf-schemas-flag";

const validCondition = {
  attribute: "plan",
  operator: "eq" as const,
  value: "enterprise",
};

const validConditionIn = {
  attribute: "country",
  operator: "in" as const,
  value: ["US", "CA"],
};

const validPercentageRollout = {
  percentage: 50,
  salt: "rule-abc",
};

const validSegment = {
  id: "seg_1",
  appId: "app_1",
  name: "Enterprise Users",
  conditions: [validCondition],
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-02T00:00:00Z",
};

describe("ConditionOperatorSchema", () => {
  it("accepts every declared operator", () => {
    for (const op of conditionOperators) {
      expect(ConditionOperatorSchema.safeParse(op).success).toBe(true);
    }
  });

  it("rejects an unknown operator", () => {
    expect(ConditionOperatorSchema.safeParse("contains").success).toBe(false);
    expect(ConditionOperatorSchema.safeParse("").success).toBe(false);
    expect(ConditionOperatorSchema.safeParse(null).success).toBe(false);
  });

  it.each(["segment_in", "segment_not_in"])("rejects runtime Segment operator %s", (operator) => {
    expect(ConditionOperatorSchema.safeParse(operator).success).toBe(false);
  });
});

describe("ConditionSchema", () => {
  it("parses a scalar-value condition", () => {
    const c = ConditionSchema.parse(validCondition);
    expect(c.attribute).toBe("plan");
    expect(c.operator).toBe("eq");
  });

  it("parses an array-value condition with 'in'", () => {
    const c = ConditionSchema.parse(validConditionIn);
    expect(c.operator).toBe("in");
    expect(Array.isArray(c.value)).toBe(true);
  });

  it("rejects 'in' operator with a non-array value", () => {
    expect(ConditionSchema.safeParse({ ...validConditionIn, value: "US" }).success).toBe(false);
  });

  it("rejects 'not_in' operator with a non-array value", () => {
    expect(
      ConditionSchema.safeParse({
        attribute: "country",
        operator: "not_in",
        value: "US",
      }).success,
    ).toBe(false);
  });

  it("accepts 'matches' with a regex string value", () => {
    const c = ConditionSchema.parse({
      attribute: "email",
      operator: "matches",
      value: "^.*@acme\\.com$",
    });
    expect(c.operator).toBe("matches");
  });

  it("rejects an unknown operator", () => {
    expect(
      ConditionSchema.safeParse({
        attribute: "x",
        operator: "like",
        value: "foo",
      }).success,
    ).toBe(false);
  });

  it("rejects missing required fields", () => {
    expect(ConditionSchema.safeParse({ operator: "eq", value: 1 }).success).toBe(false);
  });

  it("rejects null or object elements inside an array Condition value", () => {
    expect(
      ConditionSchema.safeParse({
        attribute: "plan",
        operator: "in",
        value: [null, "paid"],
      }).success,
    ).toBe(false);
    expect(
      ConditionSchema.safeParse({
        attribute: "plan",
        operator: "in",
        value: [{ nested: true }],
      }).success,
    ).toBe(false);
  });
});

describe("PercentageRolloutSchema", () => {
  it("parses a valid rollout", () => {
    const r = PercentageRolloutSchema.parse(validPercentageRollout);
    expect(r.percentage).toBe(50);
    expect(r.salt).toBe("rule-abc");
  });

  it("accepts boundary values 0 and 100", () => {
    expect(PercentageRolloutSchema.parse({ percentage: 0, salt: "s" }).percentage).toBe(0);
    expect(PercentageRolloutSchema.parse({ percentage: 100, salt: "s" }).percentage).toBe(100);
  });

  it("accepts fractional percentages", () => {
    expect(PercentageRolloutSchema.parse({ percentage: 33.33, salt: "s" }).percentage).toBe(33.33);
  });

  it("rejects percentage > 100", () => {
    expect(PercentageRolloutSchema.safeParse({ percentage: 101, salt: "s" }).success).toBe(false);
  });

  it("rejects percentage < 0", () => {
    expect(PercentageRolloutSchema.safeParse({ percentage: -1, salt: "s" }).success).toBe(false);
  });

  it("rejects missing salt", () => {
    expect(PercentageRolloutSchema.safeParse({ percentage: 50 }).success).toBe(false);
  });

  it("rejects unknown keys rather than stripping them", () => {
    // A stored rollout with an extra key came from a writer we do not know about.
    // Stripping it would carry a shape we never validated into evaluation (ADR-0036).
    expect(
      PercentageRolloutSchema.safeParse({ percentage: 50, salt: "s", variantName: "treatment" })
        .success,
    ).toBe(false);
  });
});

describe("SegmentSchema", () => {
  it("parses a valid segment", () => {
    const s = SegmentSchema.parse(validSegment);
    expect(s.id).toBe("seg_1");
    expect(s.conditions).toHaveLength(1);
  });

  it("rejects empty conditions", () => {
    expect(SegmentSchema.safeParse({ ...validSegment, conditions: [] }).success).toBe(false);
  });

  it("accepts optional description", () => {
    const s = SegmentSchema.parse({ ...validSegment, description: "Big co tier" });
    expect(s.description).toBe("Big co tier");
  });

  it("rejects missing appId", () => {
    const { appId: _, ...rest } = validSegment;
    expect(SegmentSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects missing createdAt", () => {
    const { createdAt: _, ...rest } = validSegment;
    expect(SegmentSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects a condition with an invalid operator inside a segment", () => {
    expect(
      SegmentSchema.safeParse({
        ...validSegment,
        conditions: [{ attribute: "x", operator: "LIKE", value: "foo" }],
      }).success,
    ).toBe(false);
  });
});

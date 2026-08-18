import { describe, expect, it } from "vitest";
import {
  FlagSchema,
  ResolvedTargetingRuleSchema,
  TargetingRuleSchema,
  VariantSchema,
} from "./leaf-schemas-flag";

const validCondition = {
  attribute: "plan",
  operator: "eq" as const,
  value: "enterprise",
};

const validPercentageRollout = {
  percentage: 50,
  salt: "rule-abc",
};

const validVariant = {
  id: "var_1",
  name: "control",
  value: false,
};

const validTargetingRule = {
  id: "tr_1",
  flagId: "flag_1",
  priority: 0,
  conditions: [validCondition],
  variantId: "var_1",
};

const validFlag = {
  id: "flag_1",
  appId: "app_1",
  key: "feature-x",
  name: "Feature X",
  schema: null,
  variants: [validVariant, { id: "var_2", name: "treatment", value: "on" }],
  defaultVariantId: "var_1",
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-02T00:00:00Z",
};

describe("VariantSchema", () => {
  it("parses a boolean value variant", () => {
    const v = VariantSchema.parse(validVariant);
    expect(v.value).toBe(false);
  });

  it("parses a string value variant", () => {
    const v = VariantSchema.parse({ id: "v", name: "t", value: "on" });
    expect(v.value).toBe("on");
  });

  it("parses a number value variant", () => {
    const v = VariantSchema.parse({ id: "v", name: "t", value: 42 });
    expect(v.value).toBe(42);
  });

  it("parses a record (object) value variant", () => {
    const v = VariantSchema.parse({ id: "v", name: "t", value: { color: "red", count: 3 } });
    expect((v.value as Record<string, unknown>).color).toBe("red");
  });

  it("accepts optional description", () => {
    const v = VariantSchema.parse({ ...validVariant, description: "Control group" });
    expect(v.description).toBe("Control group");
  });

  it("rejects a function as value", () => {
    expect(VariantSchema.safeParse({ id: "v", name: "t", value: () => {} }).success).toBe(false);
  });

  it("rejects undefined as value", () => {
    expect(VariantSchema.safeParse({ id: "v", name: "t", value: undefined }).success).toBe(false);
  });

  it("rejects null as value (not in the union)", () => {
    expect(VariantSchema.safeParse({ id: "v", name: "t", value: null }).success).toBe(false);
  });

  it("rejects missing required fields", () => {
    expect(VariantSchema.safeParse({ name: "t", value: true }).success).toBe(false);
  });
});

describe("TargetingRuleSchema", () => {
  it("parses a valid targeting rule without rollout", () => {
    const r = TargetingRuleSchema.parse(validTargetingRule);
    expect(r.priority).toBe(0);
    expect(r.conditions).toHaveLength(1);
  });

  it("parses a rule with percentageRollout", () => {
    const r = TargetingRuleSchema.parse({
      ...validTargetingRule,
      percentageRollout: validPercentageRollout,
    });
    expect(r.percentageRollout?.percentage).toBe(50);
  });

  it("accepts null percentageRollout", () => {
    const r = TargetingRuleSchema.parse({ ...validTargetingRule, percentageRollout: null });
    expect(r.percentageRollout).toBeNull();
  });

  it("rejects negative priority", () => {
    expect(TargetingRuleSchema.safeParse({ ...validTargetingRule, priority: -1 }).success).toBe(
      false,
    );
  });

  it("rejects non-integer priority", () => {
    expect(TargetingRuleSchema.safeParse({ ...validTargetingRule, priority: 1.5 }).success).toBe(
      false,
    );
  });

  it("accepts a Segment-only authoring rule", () => {
    expect(
      TargetingRuleSchema.parse({
        ...validTargetingRule,
        conditions: [],
        segmentId: "segment_enterprise",
      }),
    ).toMatchObject({ segmentId: "segment_enterprise", conditions: [] });
  });

  it("rejects an authoring rule without direct Conditions or a Segment", () => {
    expect(TargetingRuleSchema.safeParse({ ...validTargetingRule, conditions: [] }).success).toBe(
      false,
    );
  });

  it("keeps Segment references and empty Conditions out of resolved rules", () => {
    expect(
      ResolvedTargetingRuleSchema.safeParse({
        ...validTargetingRule,
        segmentId: "segment_enterprise",
      }).success,
    ).toBe(false);
    expect(
      ResolvedTargetingRuleSchema.safeParse({ ...validTargetingRule, conditions: [] }).success,
    ).toBe(false);
  });
});

describe("FlagSchema", () => {
  it("parses a full valid App-level flag definition", () => {
    const f = FlagSchema.parse(validFlag);

    expect(f.id).toBe("flag_1");
    expect(f.appId).toBe("app_1");
    expect(f.key).toBe("feature-x");
    expect(f.variants).toHaveLength(2);
    expect(f.schema).toBeNull();
    expect(f.defaultVariantId).toBe("var_1");
    expect("enabled" in f).toBe(false);
  });

  it("accepts optional description", () => {
    const f = FlagSchema.parse({ ...validFlag, description: "Controls X" });
    expect(f.description).toBe("Controls X");
  });

  it("rejects a flag with no variants", () => {
    expect(FlagSchema.safeParse({ ...validFlag, variants: [] }).success).toBe(false);
  });

  it("rejects missing defaultVariantId", () => {
    const { defaultVariantId: _, ...rest } = validFlag;
    expect(FlagSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects per-Environment config fields", () => {
    expect(
      FlagSchema.safeParse({
        ...validFlag,
        environmentId: "env_prod",
        enabled: true,
        availableVariantNames: ["control"],
        targetingRules: [validTargetingRule],
      }).success,
    ).toBe(false);
  });
});

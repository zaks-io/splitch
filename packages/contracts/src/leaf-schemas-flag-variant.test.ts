import { describe, expect, it } from "vitest";
import { FlagSchema, TargetingRuleSchema, VariantSchema } from "./leaf-schemas-flag.js";

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
  environmentId: "env_prod",
  enabled: true,
  availableVariantNames: ["control", "treatment"],
  defaultVariantId: "var_1",
  targetingRules: [validTargetingRule],
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

  it("rejects empty conditions array", () => {
    expect(TargetingRuleSchema.safeParse({ ...validTargetingRule, conditions: [] }).success).toBe(
      false,
    );
  });
});

describe("FlagSchema", () => {
  it("parses a full valid flag including definition and config sections", () => {
    const f = FlagSchema.parse(validFlag);

    // DEFINITION fields
    expect(f.id).toBe("flag_1");
    expect(f.appId).toBe("app_1");
    expect(f.key).toBe("feature-x");
    expect(f.variants).toHaveLength(2);
    expect(f.schema).toBeNull();

    // CONFIGURATION fields
    expect(f.environmentId).toBe("env_prod");
    expect(f.enabled).toBe(true);
    expect(f.defaultVariantId).toBe("var_1");
    expect(f.availableVariantNames).toEqual(["control", "treatment"]);
    expect(f.targetingRules).toHaveLength(1);
  });

  it("accepts optional description", () => {
    const f = FlagSchema.parse({ ...validFlag, description: "Controls X" });
    expect(f.description).toBe("Controls X");
  });

  it("rejects a flag with no variants", () => {
    expect(FlagSchema.safeParse({ ...validFlag, variants: [] }).success).toBe(false);
  });

  it("rejects missing environmentId", () => {
    const { environmentId: _, ...rest } = validFlag;
    expect(FlagSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects missing defaultVariantId", () => {
    const { defaultVariantId: _, ...rest } = validFlag;
    expect(FlagSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects missing enabled", () => {
    const { enabled: _, ...rest } = validFlag;
    expect(FlagSchema.safeParse(rest).success).toBe(false);
  });
});

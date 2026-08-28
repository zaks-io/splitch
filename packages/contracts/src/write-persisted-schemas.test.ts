import { describe, expect, it } from "vitest";
import { VariantSchema } from "./leaf-schemas-flag";
import {
  PERSISTED_ARRAY_MAX_ITEMS,
  PERSISTED_CONDITION_ATTRIBUTE_MAX_LENGTH,
  PERSISTED_CONDITION_VALUE_MAX_LENGTH,
  PERSISTED_DESCRIPTION_MAX_LENGTH,
  PERSISTED_IDENTIFIER_MAX_LENGTH,
  PERSISTED_JSON_MAX_DEPTH,
  PERSISTED_NAME_MAX_LENGTH,
  PERSISTED_RECORD_KEY_MAX_LENGTH,
  PERSISTED_RECORD_MAX_KEYS,
  PERSISTED_VARIANT_VALUE_STRING_MAX_LENGTH,
} from "./persisted-field-limits";
import {
  EndRunRequestSchema,
  persistedJsonDepth,
  TargetingRuleInputSchema,
  WriteConditionSchema,
  WriteFlagJsonSchemaSchema,
  WriteMetricRefSchema,
  WriteVariantValueSchema,
} from "./write-persisted-schemas";

const validCondition = {
  attribute: "plan",
  operator: "eq" as const,
  value: "enterprise",
};

const validRule = {
  id: "rule-admin",
  flagId: "flag_checkout",
  priority: 0,
  conditions: [validCondition],
  variantId: "var_treatment",
};

describe("WriteConditionSchema", () => {
  it("rejects an unknown field instead of stripping it", () => {
    const result = WriteConditionSchema.safeParse({ ...validCondition, extra: true });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]).toMatchObject({
      code: "unrecognized_keys",
      keys: ["extra"],
    });
  });

  it("rejects an attribute or value over the named bound", () => {
    expect(
      WriteConditionSchema.safeParse({
        ...validCondition,
        attribute: "a".repeat(PERSISTED_CONDITION_ATTRIBUTE_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
    expect(
      WriteConditionSchema.safeParse({
        ...validCondition,
        value: "v".repeat(PERSISTED_CONDITION_VALUE_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });
});

describe("WriteVariantValueSchema", () => {
  it("accepts a string at the named bound and rejects one character over", () => {
    expect(
      WriteVariantValueSchema.safeParse("s".repeat(PERSISTED_VARIANT_VALUE_STRING_MAX_LENGTH))
        .success,
    ).toBe(true);
    expect(
      WriteVariantValueSchema.safeParse("s".repeat(PERSISTED_VARIANT_VALUE_STRING_MAX_LENGTH + 1))
        .success,
    ).toBe(false);
  });

  it("rejects a record over the named key bound", () => {
    const record = Object.fromEntries(
      Array.from({ length: PERSISTED_RECORD_MAX_KEYS + 1 }, (_, index) => [`k${index}`, index]),
    );
    expect(WriteVariantValueSchema.safeParse(record).success).toBe(false);
  });

  it("rejects nested JSON deeper than the named depth bound", () => {
    let nested: unknown = "leaf";
    for (let depth = 1; depth < PERSISTED_JSON_MAX_DEPTH; depth += 1) {
      nested = { child: nested };
    }
    expect(persistedJsonDepth(nested)).toBe(PERSISTED_JSON_MAX_DEPTH);
    expect(WriteVariantValueSchema.safeParse(nested).success).toBe(true);
    expect(WriteVariantValueSchema.safeParse({ overflow: nested }).success).toBe(false);
  });

  it("rejects a root array and accepts a nested array inside an object", () => {
    expect(WriteVariantValueSchema.safeParse([]).success).toBe(false);
    expect(WriteVariantValueSchema.safeParse(["x"]).success).toBe(false);
    expect(WriteVariantValueSchema.safeParse({ items: ["x"] }).success).toBe(true);
  });

  it("accepts nested null so write matches the canonical Variant object shape", () => {
    expect(VariantSchema.safeParse({ id: "v", name: "nested", value: { a: null } }).success).toBe(
      true,
    );
    expect(WriteVariantValueSchema.safeParse({ a: null }).success).toBe(true);
    expect(WriteVariantValueSchema.safeParse({ items: [null] }).success).toBe(true);
    expect(WriteVariantValueSchema.safeParse(null).success).toBe(false);
  });

  it("rejects non-finite numbers that JSON would persist as null", () => {
    expect(WriteVariantValueSchema.safeParse(Number.POSITIVE_INFINITY).success).toBe(false);
    expect(WriteVariantValueSchema.safeParse({ a: Number.POSITIVE_INFINITY }).success).toBe(false);
    expect(WriteVariantValueSchema.safeParse({ a: Number.NaN }).success).toBe(false);
  });
});

describe("WriteFlagJsonSchemaSchema", () => {
  it("accepts a typical Flag JSON Schema document", () => {
    expect(WriteFlagJsonSchemaSchema.safeParse({ type: "boolean" }).success).toBe(true);
    expect(
      WriteFlagJsonSchemaSchema.safeParse({
        type: "object",
        properties: { items: { type: "array" } },
      }).success,
    ).toBe(true);
  });

  it("rejects nested strings, arrays, records, keys, and depth over the named bounds", () => {
    expect(
      WriteFlagJsonSchemaSchema.safeParse({
        title: "s".repeat(PERSISTED_VARIANT_VALUE_STRING_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
    expect(
      WriteFlagJsonSchemaSchema.safeParse({
        enum: Array.from({ length: PERSISTED_ARRAY_MAX_ITEMS + 1 }, (_, index) => `v${index}`),
      }).success,
    ).toBe(false);
    expect(
      WriteFlagJsonSchemaSchema.safeParse({
        properties: Object.fromEntries(
          Array.from({ length: PERSISTED_RECORD_MAX_KEYS + 1 }, (_, index) => [
            `k${index}`,
            { type: "string" },
          ]),
        ),
      }).success,
    ).toBe(false);
    expect(
      WriteFlagJsonSchemaSchema.safeParse({
        properties: { ["k".repeat(PERSISTED_RECORD_KEY_MAX_LENGTH + 1)]: { type: "string" } },
      }).success,
    ).toBe(false);

    let nested: unknown = "leaf";
    for (let depth = 1; depth < PERSISTED_JSON_MAX_DEPTH; depth += 1) {
      nested = { child: nested };
    }
    expect(WriteFlagJsonSchemaSchema.safeParse(nested).success).toBe(true);
    expect(WriteFlagJsonSchemaSchema.safeParse({ overflow: nested }).success).toBe(false);
  });

  it("rejects non-finite schema numbers before they stringify to null", () => {
    const fromLiteral = JSON.parse('{"type":"number","maximum":1e400}') as Record<string, unknown>;
    expect(fromLiteral.maximum).toBe(Number.POSITIVE_INFINITY);
    expect(WriteFlagJsonSchemaSchema.safeParse(fromLiteral).success).toBe(false);
    expect(
      WriteFlagJsonSchemaSchema.safeParse({ type: "number", maximum: Number.POSITIVE_INFINITY })
        .success,
    ).toBe(false);
    expect(
      WriteFlagJsonSchemaSchema.safeParse({ type: "number", minimum: Number.NEGATIVE_INFINITY })
        .success,
    ).toBe(false);
  });
});

describe("WriteMetricRefSchema", () => {
  it("rejects an unknown field and an over-limit metricId", () => {
    const extra = WriteMetricRefSchema.safeParse({ metricId: "metric_1", extra: true });
    expect(extra.success).toBe(false);
    if (extra.success) return;
    expect(extra.error.issues[0]).toMatchObject({ code: "unrecognized_keys", keys: ["extra"] });
    expect(
      WriteMetricRefSchema.safeParse({
        metricId: "m".repeat(PERSISTED_IDENTIFIER_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });
});

describe("TargetingRuleInputSchema", () => {
  it("rejects an unknown field on the rule and on a nested Condition", () => {
    const rule = TargetingRuleInputSchema.safeParse({ ...validRule, extra: true });
    expect(rule.success).toBe(false);
    if (rule.success) return;
    expect(rule.error.issues[0]).toMatchObject({ code: "unrecognized_keys", keys: ["extra"] });

    const condition = TargetingRuleInputSchema.safeParse({
      ...validRule,
      conditions: [{ ...validCondition, extra: true }],
    });
    expect(condition.success).toBe(false);
    if (condition.success) return;
    expect(condition.error.issues[0]).toMatchObject({
      code: "unrecognized_keys",
      keys: ["extra"],
    });
  });

  it("rejects more Conditions than the named array bound", () => {
    const conditions = Array.from({ length: PERSISTED_ARRAY_MAX_ITEMS + 1 }, (_, index) => ({
      ...validCondition,
      attribute: `a${index}`,
    }));
    expect(TargetingRuleInputSchema.safeParse({ ...validRule, conditions }).success).toBe(false);
  });
});

describe("EndRunRequestSchema", () => {
  it("rejects an unknown field and an over-limit reason", () => {
    const extra = EndRunRequestSchema.safeParse({ extra: true });
    expect(extra.success).toBe(false);
    if (extra.success) return;
    expect(extra.error.issues[0]).toMatchObject({ code: "unrecognized_keys", keys: ["extra"] });
    expect(
      EndRunRequestSchema.safeParse({ reason: "r".repeat(PERSISTED_DESCRIPTION_MAX_LENGTH + 1) })
        .success,
    ).toBe(false);
    expect(EndRunRequestSchema.safeParse({ reason: "done" }).success).toBe(true);
  });
});

describe("write name bound stays absolute", () => {
  it("keeps the documented name ceiling", () => {
    expect(PERSISTED_NAME_MAX_LENGTH).toBe(200);
  });
});

import { z } from "zod";

/**
 * Canonical Zod leaf schemas for the flag-side glossary nouns.
 * Source of truth: docs/spec/contracts/leaf-schemas-flag.md
 *
 * Every envelope (request, response, storage) composes these leaves and never
 * redefines them. Any field addition here propagates automatically.
 */

// ---------------------------------------------------------------------------
// ConditionOperator
// ---------------------------------------------------------------------------

export const conditionOperators = [
  "eq",
  "neq",
  "gt",
  "lt",
  "gte",
  "lte",
  "in",
  "not_in",
  "matches",
  "not_matches",
] as const;

export const ConditionOperatorSchema = z.enum(conditionOperators);
export type ConditionOperator = z.infer<typeof ConditionOperatorSchema>;

// ---------------------------------------------------------------------------
// Condition
// ---------------------------------------------------------------------------

// `in`/`not_in` require an array value; all other operators accept a scalar or array.
const ScalarConditionValue = z.union([z.boolean(), z.string(), z.number()]);
const ArrayConditionValue = z.array(z.unknown());
const ConditionValue = z.union([ScalarConditionValue, ArrayConditionValue]);

const BaseConditionSchema = z.object({
  attribute: z.string(),
  operator: ConditionOperatorSchema,
  value: ConditionValue,
});

// Array operators are validated as a discriminated refinement so the schema
// rejects a non-array value for `in`/`not_in` loudly at parse time.
export const ConditionSchema = BaseConditionSchema.refine(
  (c) => {
    if (c.operator === "in" || c.operator === "not_in") {
      return Array.isArray(c.value);
    }
    return true;
  },
  { message: "operator 'in' / 'not_in' requires value to be an array" },
);
export type Condition = z.infer<typeof ConditionSchema>;

// ---------------------------------------------------------------------------
// PercentageRollout
// ---------------------------------------------------------------------------

export const PercentageRolloutSchema = z.object({
  // 0–100 inclusive; fractional allowed
  percentage: z.number().min(0).max(100),
  salt: z.string(),
});
export type PercentageRollout = z.infer<typeof PercentageRolloutSchema>;

// ---------------------------------------------------------------------------
// Variant
// ---------------------------------------------------------------------------

export const VariantSchema = z.object({
  id: z.string(),
  name: z.string(),
  value: z.union([z.boolean(), z.string(), z.number(), z.record(z.string(), z.unknown())]),
  description: z.string().optional(),
});
export type Variant = z.infer<typeof VariantSchema>;

// ---------------------------------------------------------------------------
// TargetingRule
// ---------------------------------------------------------------------------

export const TargetingRuleSchema = z.object({
  id: z.string(),
  flagId: z.string(),
  // Integer ≥ 0; lower = evaluated first
  priority: z.number().int().min(0),
  conditions: z.array(ConditionSchema).min(1),
  variantId: z.string(),
  percentageRollout: PercentageRolloutSchema.nullable().optional(),
});
export type TargetingRule = z.infer<typeof TargetingRuleSchema>;

// ---------------------------------------------------------------------------
// Flag
//
// DEFINITION fields (App-level): id, appId, key, name, description, schema, variants
// CONFIGURATION fields (per-Environment, ADR-0027): environmentId, enabled,
//   availableVariantNames, defaultVariantId, targetingRules
// ---------------------------------------------------------------------------

export const FlagSchema = z.object({
  // DEFINITION — App-level; frozen once set
  id: z.string(),
  appId: z.string(),
  key: z.string(),
  name: z.string(),
  description: z.string().optional(),
  // null = unconstrained (any variant value passes)
  schema: z.record(z.string(), z.unknown()).nullable().optional(),
  variants: z.array(VariantSchema).min(1),

  // CONFIGURATION — per-Environment (ADR-0027)
  environmentId: z.string(),
  enabled: z.boolean(),
  availableVariantNames: z.array(z.string()),
  defaultVariantId: z.string(),
  targetingRules: z.array(TargetingRuleSchema),

  // Audit timestamps (ISO 8601)
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Flag = z.infer<typeof FlagSchema>;

// ---------------------------------------------------------------------------
// Segment
// ---------------------------------------------------------------------------

export const SegmentSchema = z.object({
  id: z.string(),
  appId: z.string(),
  name: z.string(),
  // AND-combined; Entity "in Segment" iff all conditions match
  conditions: z.array(ConditionSchema),
  description: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Segment = z.infer<typeof SegmentSchema>;

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
// Array elements are the same scalar union the Panel can render — a null or object
// element is a write-time 400, not a 200 that poisons a later Panel list parse.
const ScalarConditionValue = z.union([z.boolean(), z.string(), z.number()]);
const ArrayConditionValue = z.array(ScalarConditionValue);
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

// Strict: a stored rollout carrying an unexpected key means something wrote a
// shape we do not understand, and stripping it would degrade silently (ADR-0036).
export const PercentageRolloutSchema = z
  .object({
    // 0–100 inclusive; fractional allowed
    percentage: z.number().min(0).max(100),
    salt: z.string(),
  })
  .strict();
export type PercentageRollout = z.infer<typeof PercentageRolloutSchema>;

/**
 * Authoring shape for a Targeting Rule rollout.
 *
 * `salt` is accepted only so a stored rule can round-trip through the replace
 * endpoint. The Control Plane decides whether that salt belongs to the existing
 * rule and rejects it when no persisted salt exists.
 */
export const TargetingRuleRolloutInputSchema = z
  .object({
    percentage: z.number().min(0).max(100),
    salt: z.string().optional(),
  })
  .strict();
export type TargetingRuleRolloutInput = z.infer<typeof TargetingRuleRolloutInputSchema>;

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

const TargetingRuleCoreFields = {
  id: z.string(),
  flagId: z.string(),
  // Integer ≥ 0; lower = evaluated first
  priority: z.number().int().min(0),
  conditions: z.array(ConditionSchema),
  variantId: z.string(),
};

const TargetingRuleFields = {
  ...TargetingRuleCoreFields,
  percentageRollout: PercentageRolloutSchema.nullable().optional(),
};

export const TargetingRuleInputSchema = z
  .object({
    ...TargetingRuleCoreFields,
    segmentId: z.string().optional(),
    percentageRollout: TargetingRuleRolloutInputSchema.nullable().optional(),
  })
  .refine((rule) => rule.conditions.length > 0 || rule.segmentId !== undefined, {
    message: "a Targeting Rule requires direct Conditions or a Segment",
    path: ["conditions"],
  });
export type TargetingRuleInput = z.infer<typeof TargetingRuleInputSchema>;

export const TargetingRuleSchema = z
  .object({
    ...TargetingRuleFields,
    segmentId: z.string().optional(),
  })
  .refine((rule) => rule.conditions.length > 0 || rule.segmentId !== undefined, {
    message: "a Targeting Rule requires direct Conditions or a Segment",
    path: ["conditions"],
  });
export type TargetingRule = z.infer<typeof TargetingRuleSchema>;

/** Concrete publication/Run projection. Segment references never reach evaluation. */
export const ResolvedTargetingRuleSchema = z
  .object({
    ...TargetingRuleFields,
    conditions: z.array(ConditionSchema).min(1),
  })
  .strict();
export type ResolvedTargetingRule = z.infer<typeof ResolvedTargetingRuleSchema>;

// ---------------------------------------------------------------------------
// Flag
//
// App-level DEFINITION only: key, value schema, Variant catalog, and Default
// Variant. Per-Environment Configuration (`enabled`, availability, targeting)
// lives in FlagConfigResponse / FlagConfigKV, not this App-level leaf.
// ---------------------------------------------------------------------------

export const FlagSchema = z
  .object({
    id: z.string(),
    appId: z.string(),
    key: z.string(),
    name: z.string(),
    description: z.string().optional(),
    // null = unconstrained (any variant value passes)
    schema: z.record(z.string(), z.unknown()).nullable().optional(),
    variants: z.array(VariantSchema).min(1),
    defaultVariantId: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type Flag = z.infer<typeof FlagSchema>;

// ---------------------------------------------------------------------------
// Segment
// ---------------------------------------------------------------------------

export const SegmentSchema = z.object({
  id: z.string(),
  appId: z.string(),
  name: z.string(),
  // AND-combined; Entity "in Segment" iff all conditions match
  conditions: z.array(ConditionSchema).min(1),
  description: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Segment = z.infer<typeof SegmentSchema>;

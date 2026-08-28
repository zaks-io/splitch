import { z } from "zod";
import { ConditionOperatorSchema } from "./leaf-schemas-flag";
import {
  PERSISTED_ARRAY_MAX_ITEMS,
  PERSISTED_JSON_MAX_DEPTH,
  PERSISTED_RECORD_KEY_MAX_LENGTH,
  PERSISTED_RECORD_MAX_KEYS,
  PersistedConditionAttributeSchema,
  PersistedConditionValueStringSchema,
  PersistedDescriptionSchema,
  PersistedIdentifierSchema,
  PersistedSaltSchema,
  PersistedVariantValueStringSchema,
  persistedArray,
  persistedRecord,
} from "./persisted-field-limits";

/**
 * Write-only persisted schemas. Storage and response leaves stay unbounded so
 * retained KV/D1 rows remain readable. Bounds and `.strict()` apply here only.
 */

const writeScalarConditionValue = z.union([
  z.boolean(),
  PersistedConditionValueStringSchema,
  z.number(),
]);

export const WriteConditionSchema = z
  .object({
    attribute: PersistedConditionAttributeSchema,
    operator: ConditionOperatorSchema,
    value: z.union([writeScalarConditionValue, persistedArray(writeScalarConditionValue)]),
  })
  .strict()
  .refine(
    (condition) => {
      if (condition.operator === "in" || condition.operator === "not_in") {
        return Array.isArray(condition.value);
      }
      return true;
    },
    { message: "operator 'in' / 'not_in' requires value to be an array" },
  );
export type WriteCondition = z.infer<typeof WriteConditionSchema>;

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
    salt: PersistedSaltSchema.optional(),
  })
  .strict();
export type TargetingRuleRolloutInput = z.infer<typeof TargetingRuleRolloutInputSchema>;

export const TargetingRuleInputSchema = z
  .object({
    id: PersistedIdentifierSchema,
    flagId: PersistedIdentifierSchema,
    priority: z.number().int().min(0),
    conditions: persistedArray(WriteConditionSchema),
    variantId: PersistedIdentifierSchema,
    segmentId: PersistedIdentifierSchema.optional(),
    percentageRollout: TargetingRuleRolloutInputSchema.nullable().optional(),
  })
  .strict()
  .refine((rule) => rule.conditions.length > 0 || rule.segmentId !== undefined, {
    message: "a Targeting Rule requires direct Conditions or a Segment",
    path: ["conditions"],
  });
export type TargetingRuleInput = z.infer<typeof TargetingRuleInputSchema>;

function writeVariantValueSchema(remainingDepth: number): z.ZodType<unknown> {
  const scalar = z.union([z.boolean(), z.number(), PersistedVariantValueStringSchema]);
  if (remainingDepth <= 1) {
    return scalar;
  }
  const nested = writeVariantValueSchema(remainingDepth - 1);
  return z.union([scalar, persistedArray(nested), persistedRecord(nested)]);
}

export const WriteVariantValueSchema = writeVariantValueSchema(PERSISTED_JSON_MAX_DEPTH);

export const WriteMetricRefSchema = z
  .object({
    metricId: PersistedIdentifierSchema,
  })
  .strict();
export type WriteMetricRef = z.infer<typeof WriteMetricRefSchema>;

export const EndRunRequestSchema = z
  .object({
    reason: PersistedDescriptionSchema.optional(),
  })
  .strict();
export type EndRunRequest = z.infer<typeof EndRunRequestSchema>;

export function persistedJsonDepth(value: unknown): number {
  if (value === null || typeof value !== "object") {
    return 1;
  }
  const children = Array.isArray(value) ? value : Object.values(value);
  if (children.length === 0) {
    return 1;
  }
  return 1 + Math.max(...children.map(persistedJsonDepth));
}

export function addClosedJsonWriteIssues(
  value: unknown,
  context: z.RefinementCtx,
  path: Array<string | number>,
  depth = 1,
): void {
  if (depth > PERSISTED_JSON_MAX_DEPTH) {
    context.addIssue({
      code: "custom",
      path,
      message: `exceeds persisted JSON max depth of ${PERSISTED_JSON_MAX_DEPTH}`,
    });
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return;
  }
  const node = value as Record<string, unknown>;
  addClosedJsonObjectIssues(node, context, path, depth);
  if (node.type === "array") {
    addClosedJsonWriteIssues(node.items, context, [...path, "items"], depth + 1);
  }
}

function addClosedJsonObjectIssues(
  node: Record<string, unknown>,
  context: z.RefinementCtx,
  path: Array<string | number>,
  depth: number,
): void {
  if (node.type !== "object" || !node.properties || typeof node.properties !== "object") {
    return;
  }
  const properties = node.properties as Record<string, unknown>;
  const keys = Object.keys(properties);
  if (keys.length > PERSISTED_RECORD_MAX_KEYS) {
    context.addIssue({
      code: "custom",
      path: [...path, "properties"],
      message: `must contain at most ${PERSISTED_RECORD_MAX_KEYS} keys`,
    });
  }
  for (const key of keys) {
    if (key.length > PERSISTED_RECORD_KEY_MAX_LENGTH) {
      context.addIssue({
        code: "custom",
        path: [...path, "properties", key],
        message: `key longer than ${PERSISTED_RECORD_KEY_MAX_LENGTH}`,
      });
    }
    addClosedJsonWriteIssues(properties[key], context, [...path, "properties", key], depth + 1);
  }
  if (Array.isArray(node.required) && node.required.length > PERSISTED_ARRAY_MAX_ITEMS) {
    context.addIssue({
      code: "custom",
      path: [...path, "required"],
      message: `must contain at most ${PERSISTED_ARRAY_MAX_ITEMS} items`,
    });
  }
}

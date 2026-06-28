import { z } from "zod";
import { EvaluationContextSchema, VariantValueSchema } from "./leaf-schemas-runtime.js";

/**
 * Shared wire envelope conventions, composed from existing leaves.
 * Source of truth: docs/spec/contracts/request-response-envelopes-conventions.md
 *
 * Two conventions this slice establishes for the wire:
 *   1. Optional wire fields are PRESENT-WITH-NULL (`.nullable()`), never omitted
 *      (`.optional()`). Consumers never need `hasOwnProperty`; the field always
 *      exists, the value may be `null`.
 *   2. Non-revealing / closed response shapes are `.strict()` so an extra field
 *      (e.g. a leaked `reason` on the public data plane) is REJECTED loudly,
 *      not silently passed through (ADR-0018, ADR-0036).
 */

// ---------------------------------------------------------------------------
// PaginatedResponse<T> (reused by every list endpoint)
//
// Cursor-based, never offset-based. `cursor` is present-with-null (null = last
// page). `total` is present-with-null because Tinybird-backed lists cannot count
// cheaply and return `total: null`; D1-backed lists return a number.
// A factory keeps the wrapper generic while preserving the item schema's type.
// ---------------------------------------------------------------------------

export const PAGINATION_DEFAULT_LIMIT = 50;
export const PAGINATION_MAX_LIMIT = 500;

export function paginatedResponse<ItemSchema extends z.ZodTypeAny>(itemSchema: ItemSchema) {
  return z.object({
    items: z.array(itemSchema),
    // Opaque server-encoded token; null on the last page.
    cursor: z.string().nullable(),
    // The limit that was applied to produce this page.
    limit: z.number().int().min(1).max(PAGINATION_MAX_LIMIT),
    // null on Tinybird-backed lists (counting 100M+ rows is too costly).
    total: z.number().int().min(0).nullable(),
  });
}

// ---------------------------------------------------------------------------
// PaginationQuery
//
// Request params for any list endpoint. `limit` defaults to 50 and is capped at
// 500 — a `limit > 500` is REJECTED at the schema level (fail loud, never
// clamped silently), surfacing as `INVALID_PAGINATION { field: 'limit' }`.
// ---------------------------------------------------------------------------

export const PaginationQuerySchema = z.object({
  limit: z.number().int().min(1).max(PAGINATION_MAX_LIMIT).default(PAGINATION_DEFAULT_LIMIT),
  // Present-with-null: absent and explicit-null both mean "first page".
  cursor: z.string().nullable().default(null),
});
export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;

// ---------------------------------------------------------------------------
// Data-plane evaluate (public SDK path, Client Key)
//
// The response is the BARE { variant } and nothing else. `.strict()` makes a
// stray `reason` / `rule` / `salt` a loud parse failure so internals can never
// leak under a public Client Key (ADR-0018). `variant` is present-with-null:
// null when the Flag is not found or disabled with no Default Variant.
// ---------------------------------------------------------------------------

export const DataPlaneEvaluateRequestSchema = z.object({
  flagKey: z.string(),
  targetingKey: z.string(),
  idType: z.string(),
  // Defaults to {} when the caller omits the attribute bag.
  attributes: EvaluationContextSchema.shape.attributes.default({}),
});
export type DataPlaneEvaluateRequest = z.infer<typeof DataPlaneEvaluateRequestSchema>;

export const DataPlaneEvaluateResponseSchema = z
  .object({
    variant: VariantValueSchema.nullable(),
  })
  .strict();
export type DataPlaneEvaluateResponse = z.infer<typeof DataPlaneEvaluateResponseSchema>;

// ---------------------------------------------------------------------------
// Test-evaluation (dry-run, control-plane token)
//
// Returns both the Variant name and resolved value plus a structured reason.
// `liveRunId` is present-with-null (null when no Run is live). Writes nothing,
// emits no Exposure (ADR-0026).
// ---------------------------------------------------------------------------

export const TestEvaluationRequestSchema = z.object({
  evaluationContext: EvaluationContextSchema,
});
export type TestEvaluationRequest = z.infer<typeof TestEvaluationRequestSchema>;

// `selection` distinguishes a direct rule hit from a percentage rollout; the
// `rollout` weights are present only on a percentage_rollout match and are
// present-with-null otherwise (no salt or bucket internals are revealed).
export const RuleSelectionSchema = z.enum(["direct", "percentage_rollout"]);
export type RuleSelection = z.infer<typeof RuleSelectionSchema>;

const RolloutWeightSchema = z.object({
  variantName: z.string(),
  weight: z.number(),
});

// Discriminated union on `type` so consumers narrow on the discriminant.
export const TestEvaluationReasonSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("holdover_replay"),
    priorRunId: z.string(),
  }),
  z.object({
    type: z.literal("rule_matched"),
    ruleId: z.string(),
    ruleName: z.string().nullable(),
    priority: z.number(),
    selection: RuleSelectionSchema,
    // Present-with-null: the weight set on a percentage_rollout, null otherwise.
    rollout: z.object({ variantWeights: z.array(RolloutWeightSchema) }).nullable(),
  }),
  z.object({ type: z.literal("default_disabled") }),
  z.object({ type: z.literal("no_match_default") }),
]);
export type TestEvaluationReason = z.infer<typeof TestEvaluationReasonSchema>;

export const TestEvaluationResponseSchema = z.object({
  variantName: z.string(),
  value: VariantValueSchema,
  reason: TestEvaluationReasonSchema,
  liveRunId: z.string().nullable(),
});
export type TestEvaluationResponse = z.infer<typeof TestEvaluationResponseSchema>;

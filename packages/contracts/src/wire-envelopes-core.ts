import { z } from "zod";
import { EvaluationContextSchema } from "./leaf-schemas-runtime";
import {
  type DataPlaneEvaluateResponse,
  DataPlaneEvaluateResponseSchema,
  type PeekEvaluateResponse,
  PeekEvaluateResponseSchema,
} from "./leaves/data-plane-evaluate-wire";
import {
  type EvaluateAllEntry,
  EvaluateAllEntrySchema,
  type EvaluateAllReason,
  EvaluateAllReasonSchema,
  type EvaluateAllRequest,
  EvaluateAllRequestSchema,
  type EvaluateAllResponse,
  EvaluateAllResponseSchema,
} from "./leaves/evaluate-all-wire";
import { VariantValueSchema } from "./leaves/variant-value";

export {
  type DataPlaneEvaluateResponse,
  DataPlaneEvaluateResponseSchema,
  type EvaluateAllEntry,
  EvaluateAllEntrySchema,
  type EvaluateAllReason,
  EvaluateAllReasonSchema,
  type EvaluateAllRequest,
  EvaluateAllRequestSchema,
  type EvaluateAllResponse,
  EvaluateAllResponseSchema,
  type PeekEvaluateResponse,
  PeekEvaluateResponseSchema,
};

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
  limit: z.coerce.number().int().min(1).max(PAGINATION_MAX_LIMIT).default(PAGINATION_DEFAULT_LIMIT),
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

const NonEmptyDataPlaneStringSchema = z.string().min(1);

export const DataPlaneEvaluateRequestSchema = z.object({
  // Optional assertion only. The Evaluation Worker scopes from the Client Key,
  // rejects mismatches, and discards matches before Provider reads.
  appId: NonEmptyDataPlaneStringSchema.optional(),
  flagKey: NonEmptyDataPlaneStringSchema,
  targetingKey: NonEmptyDataPlaneStringSchema,
  idType: NonEmptyDataPlaneStringSchema,
  // Defaults to {} when the caller omits the attribute bag.
  attributes: EvaluationContextSchema.shape.attributes.default({}),
});
export type DataPlaneEvaluateRequest = z.infer<typeof DataPlaneEvaluateRequestSchema>;

/** Non-billable, privacy-minimal SDK cache-hit telemetry. */
export const CachedEvaluationTelemetryRequestSchema = z
  .object({
    flagKey: NonEmptyDataPlaneStringSchema,
    idempotencyKey: NonEmptyDataPlaneStringSchema.max(255),
  })
  .strict();
export const CachedEvaluationTelemetryResponseSchema = z.object({ ok: z.literal(true) }).strict();

// Data-plane evaluate response leaves live in ./leaves/data-plane-evaluate-wire.ts.

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
  z.object({ type: z.literal("fresh_assignment") }),
  z.object({ type: z.literal("default_disabled") }),
  // The config-level baseline rollout decided this, not a Targeting Rule. It is
  // its own reason so an operator can tell a baseline hit from a plain fall-
  // through to the Default Variant — the two produce the same Variant whenever
  // the key lands outside the band, and conflating them would hide the rollout.
  z.object({
    type: z.literal("baseline_rollout"),
    rollout: z.object({ variantWeights: z.array(RolloutWeightSchema) }),
  }),
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

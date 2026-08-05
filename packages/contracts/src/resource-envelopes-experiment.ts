import { z } from "zod";
import { ExperimentSchema, MetricRefSchema, RunSchema } from "./leaf-schemas-experiment";
import { TargetingRuleSchema, VariantSchema } from "./leaf-schemas-flag";
import {
  ApprovalRequestSchema,
  InlineApproveAndApplyReviewSchema,
} from "./routes/route-shapes-approval-request";
import { TargetingKeyTypeSchema } from "./targeting-key-type";

/**
 * Create/patch/response wire envelopes for the Experiment and Experiment Run
 * control-plane resources, composed from the experiment-side leaves.
 * Source of truth: docs/spec/contracts/request-response-envelopes-experiment-run.md
 *
 * Two structural guards live here (the rest of the edit taxonomy is a Worker-side
 * runtime check against live Run state):
 *   - `CreateExperimentRequest` omits `defaultVariantId` — it is Worker-copied
 *     from the bound Flag, not caller input, so there is one source of truth.
 *   - `PatchRunRequest` is `.strict()` and never names a frozen assignment field,
 *     so carrying ANY of them fails at parse time (ADR-0002/0003 enforced in Zod).
 */

// Re-export write-boundary vocabulary through the resource-envelopes barrel so
// `@splitch/contracts` resolves it for Panel validators and Worker tests.
// `index.ts` is already over the code-line ratchet; adding a dedicated export
// there (as SlugSchema does) would grow an already-over file and fail the gate.
// biome-ignore lint/performance/noBarrelFile: shared write-boundary vocabulary for Panel + Worker tests
export {
  TARGETING_KEY_TYPE_MAX_LENGTH,
  TARGETING_KEY_TYPE_SHAPE_MESSAGE,
  TargetingKeyTypeSchema,
} from "./targeting-key-type";

// ---------------------------------------------------------------------------
const DraftAllocationSchema = z.record(z.string(), z.number());

// ---------------------------------------------------------------------------
// CreateExperimentRequest
//
// `defaultVariantId` is intentionally absent: the Worker copies it from the bound
// Flag's per-Environment default (resolved via flagId + environmentId), so the
// request PARSES WITHOUT it. `metrics` is `MetricRef[]` with min 0. Worker sets
// id/status/liveRunId/createdAt/updatedAt/defaultVariantId.
// Draft assignment fields are intentionally shape-only here. Start validates the
// staged draft and returns domain errors such as ALLOCATION_INVALID.
// ---------------------------------------------------------------------------

export const CreateExperimentRequestSchema = z.object({
  appId: z.string(),
  environmentId: z.string(),
  name: z.string(),
  // Unique per (App, Environment).
  key: z.string(),
  flagId: z.string(),
  // EC field + Entity type bucketed on; inherited by all Runs.
  targetingKey: z.string(),
  targetingKeyType: TargetingKeyTypeSchema,
  description: z.string().optional(),
  hypothesis: z.string().optional(),
  confidenceLevel: ExperimentSchema.shape.confidenceLevel.default(0.95),
  metrics: z.array(MetricRefSchema).min(0),
  guardrailMetrics: z.array(MetricRefSchema).default([]),
  activationMetricId: z.string().nullable().optional(),
  conversionWindowMs: z.number().default(0),
  dimensions: z.array(z.string()).default([]),
  allocation: DraftAllocationSchema.optional(),
  salt: z.string().optional(),
  targetingRules: z.array(TargetingRuleSchema).optional(),
  segmentIds: z.array(z.string()).optional(),
  idempotency_key: z.string().optional(),
});
export type CreateExperimentRequest = z.infer<typeof CreateExperimentRequestSchema>;

// ---------------------------------------------------------------------------
// PatchExperimentRequest
//
// All fields optional; the Worker enforces the edit taxonomy (assignment edits →
// RUN_FROZEN, decision-locked fields → DECISION_LOCKED) against live Run state at
// runtime — those are not structural. `.strict()` still rejects unknown keys, and
// Run-level fields (horizon, targetN, sampleSizeLocked) are not patchable here at
// all (they live on the Run, not the Experiment) so they are simply absent.
// ---------------------------------------------------------------------------

export const PatchExperimentRequestSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    hypothesis: z.string().optional(),
    owner: z.string().optional(),
    tags: z.array(z.string()).optional(),
    flagId: z.string().optional(),
    targetingKey: z.string().optional(),
    targetingKeyType: TargetingKeyTypeSchema.optional(),
    activationMetricId: z.string().nullable().optional(),
    allocation: DraftAllocationSchema.optional(),
    salt: z.string().optional(),
    // Accepted structurally, ALWAYS rejected by the Worker with a 400. A Run's
    // Variant set is derived at Start from the Flag's Variant catalog and the
    // staged allocation, so the Experiment has no column for it. It stays in the
    // schema only so the refusal can point at the Flag's Variant catalog instead
    // of `.strict()` answering "unrecognized key" — see
    // `variantSetNotPatchable` in the control-plane Worker.
    variantSet: z.array(VariantSchema).optional(),
    targetingRules: z.array(TargetingRuleSchema).optional(),
    segmentIds: z.array(z.string()).optional(),
    metrics: z.array(MetricRefSchema).optional(),
    guardrailMetrics: z.array(MetricRefSchema).optional(),
    conversionWindowMs: z.number().optional(),
    dimensions: z.array(z.string()).optional(),
    confidenceLevel: z.number().optional(),
    // Assignment fields remain frozen on a running Run. This explicit marker
    // stages them for the next Run instead of pretending to edit the live one.
    stageForNextRun: z.literal(true).optional(),
  })
  .strict();
export type PatchExperimentRequest = z.infer<typeof PatchExperimentRequestSchema>;

// ---------------------------------------------------------------------------
// ExperimentResponse
// ---------------------------------------------------------------------------

export const ExperimentResponseSchema = ExperimentSchema;
export type ExperimentResponse = z.infer<typeof ExperimentResponseSchema>;

/**
 * A staged assignment edit under a live Run writes only the Experiment draft.
 * This notice names the Run that evaluation still uses and its frozen Targeting
 * Rule snapshot, so an operator cannot mistake the draft write for a live change
 * (SPL-307 / ADR-0036).
 */
export const LiveRunUnaffectedSchema = z
  .object({
    runId: z.string(),
    frozenTargetingRules: z.array(TargetingRuleSchema),
  })
  .strict();
export type LiveRunUnaffected = z.infer<typeof LiveRunUnaffectedSchema>;

/**
 * Experiment PATCH response. Extends the Experiment leaf with an optional
 * `liveRunUnaffected` notice when `stageForNextRun` staged assignment fields
 * (including Targeting Rules) while a Run is live.
 */
export const ExperimentUpdateResponseSchema = ExperimentSchema.extend({
  liveRunUnaffected: LiveRunUnaffectedSchema.optional(),
});
export type ExperimentUpdateResponse = z.infer<typeof ExperimentUpdateResponseSchema>;

// ---------------------------------------------------------------------------
// StartRunRequest (opens a new Experiment Run — the ONLY path to open one)
//
// The assignment config lives on the Experiment draft. Start validates the draft
// and freezes it into a Run. `review?` can approve and apply inline; without it,
// a gated write returns an Approval Request. `reason?` is the Run's start note.
//
// `horizon` / `sampleSizeLocked` are the two decision-spec fields that live ONLY
// on the Run (storage-schemas-d1-experiment.md), so Start — the moment a Run is
// opened — is where they are chosen. Every other decision-spec field is carried
// on the Experiment and frozen from it here.
// ---------------------------------------------------------------------------

export const RunHorizonSchema = z.enum(["sequential", "fixed"]);
export type RunHorizon = z.infer<typeof RunHorizonSchema>;

export const StartRunRequestSchema = z
  .object({
    review: InlineApproveAndApplyReviewSchema.optional(),
    reason: z.string().optional(),
    horizon: RunHorizonSchema.optional(),
    sampleSizeLocked: z.number().int().positive().nullable().optional(),
    idempotency_key: z.string().min(1),
  })
  .strict();
export type StartRunRequest = z.infer<typeof StartRunRequestSchema>;

export const StartRunResponseSchema = z
  .object({
    experimentId: z.string(),
    run: RunSchema,
    previousRunId: z.string().nullable(),
    approvalRequest: ApprovalRequestSchema.nullable(),
    // Present only when this request itself committed the Start (the direct
    // door, ADR-0047). Approval-gated responses have no committed Run to have
    // shipped a snapshot for, and Approval-applied Starts report shipping at
    // application time instead.
    runSnapshotShipped: z.boolean().optional(),
    // Explicit frozen Targeting Rule snapshot — the same set evaluation uses.
    // Empty means all Entities are eligible via allocation; Flag Configuration
    // Targeting Rules do not apply while this Run is live (SPL-307).
    frozenTargetingRules: z.array(TargetingRuleSchema),
  })
  .strict();
export type StartRunResponse = z.infer<typeof StartRunResponseSchema>;

// ---------------------------------------------------------------------------
// PatchRunRequest (non-material only)
//
// `.strict()` over only the non-material fields makes the frozen assignment
// config UN-EXPRESSIBLE at parse time: a body carrying salt / allocation /
// variantSet / targetingRules / targetingSegmentId / targetingKey is an unknown
// key and FAILS before the Worker runs. Listing the allowed fields (rather than
// `.omit()`-ing the leaf) keeps the accepted shape explicit and self-documenting.
// ---------------------------------------------------------------------------

export const PatchRunRequestSchema = z
  .object({
    description: z.string().optional(),
    owner: z.string().optional(),
    tags: z.array(z.string()).optional(),
  })
  .strict();
export type PatchRunRequest = z.infer<typeof PatchRunRequestSchema>;

// ---------------------------------------------------------------------------
// RunResponse
//
// Full Run leaf: configHash for integrity, frozen variantSet/allocation, and
// `endedAt` present-with-null on a running Run. GET also carries the Experiment
// draft Targeting Rules so operators can compare frozen vs draft without a
// second call (SPL-307).
// ---------------------------------------------------------------------------

export const RunResponseSchema = RunSchema.extend({
  draftTargetingRules: z.array(TargetingRuleSchema).nullable().optional(),
});
export type RunResponse = z.infer<typeof RunResponseSchema>;

import { z } from "zod";
import { ExperimentSchema, MetricRefSchema, RunSchema } from "./leaf-schemas-experiment";
import { TargetingRuleSchema, VariantSchema } from "./leaf-schemas-flag";
import { ApprovalRequestSchema, InlineApproveAndApplyReviewSchema } from "./routes/route-shapes";

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
  targetingKeyType: z.string(),
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
    targetingKeyType: z.string().optional(),
    activationMetricId: z.string().nullable().optional(),
    allocation: DraftAllocationSchema.optional(),
    salt: z.string().optional(),
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

// ---------------------------------------------------------------------------
// StartRunRequest (opens a new Experiment Run — the ONLY path to open one)
//
// The assignment config lives on the Experiment draft. Start validates the draft
// and freezes it into a Run. `review?` can approve and apply inline; without it,
// a gated write returns an Approval Request. `reason?` is the Run's start note.
// ---------------------------------------------------------------------------

export const StartRunRequestSchema = z
  .object({
    review: InlineApproveAndApplyReviewSchema.optional(),
    reason: z.string().optional(),
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
// `endedAt` present-with-null on a running Run.
// ---------------------------------------------------------------------------

export const RunResponseSchema = RunSchema;
export type RunResponse = z.infer<typeof RunResponseSchema>;

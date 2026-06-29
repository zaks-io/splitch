import { z } from "zod";
import { VariantSchema } from "./leaf-schemas-flag.js";
import { ExperimentSchema, MetricRefSchema, RunSchema } from "./leaf-schemas-experiment.js";

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
// CreateExperimentRequest
//
// `defaultVariantId` is intentionally absent: the Worker copies it from the bound
// Flag's per-Environment default (resolved via flagId + environmentId), so the
// request PARSES WITHOUT it. `metrics` is `MetricRef[]` with min 0. Worker sets
// id/status/liveRunId/createdAt/updatedAt/defaultVariantId.
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
  activationMetricId: z.string().optional(),
  conversionWindowMs: z.number().default(0),
  dimensions: z.array(z.string()).default([]),
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
// `status` accepts only 'ended' via PATCH (Worker validates the transition).
// ---------------------------------------------------------------------------

export const PatchExperimentRequestSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    hypothesis: z.string().optional(),
    targetingKey: z.string().optional(),
    targetingKeyType: z.string().optional(),
    activationMetricId: z.string().optional(),
    metrics: z.array(MetricRefSchema).optional(),
    guardrailMetrics: z.array(MetricRefSchema).optional(),
    conversionWindowMs: z.number().optional(),
    dimensions: z.array(z.string()).optional(),
    confidenceLevel: z.number().optional(),
    status: z.literal("ended").optional(),
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
// Carries all assignment config. `allocation` reuses the Run leaf's sum-to-100
// refinement. The Worker computes `targetingRules` (the resolved snapshot from
// `targetingSegmentId`), so it is NOT supplied here. There is NO CreateRunRequest
// — Runs are created by Start. `confirm?` makes this a gated write under the
// Environment Policy (ADR-0029); `reason?` is the Run's start note;
// `idempotency_key?` guards a retried `experiments_start`.
// ---------------------------------------------------------------------------

export const StartRunRequestSchema = z.object({
  experimentId: z.string(),
  // Snapshot of the Flag's current Variants at Start time.
  variantSet: z.array(VariantSchema),
  // Variant NAME → percentage; reuses the Run leaf's sum-to-100 guard.
  allocation: RunSchema.shape.allocation,
  // Auto-generated UUID4 by the Worker if omitted.
  salt: z.string().optional(),
  // Resolved to frozen rules at Start; the Run stores rules, never this id.
  targetingSegmentId: z.string().optional(),
  // Environment-Policy confirmation gate (ADR-0029); default false.
  confirm: z.boolean().optional(),
  reason: z.string().optional(),
  idempotency_key: z.string().optional(),
});
export type StartRunRequest = z.infer<typeof StartRunRequestSchema>;

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

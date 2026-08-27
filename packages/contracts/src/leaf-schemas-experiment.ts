import { z } from "zod";
import {
  ResolvedTargetingRuleSchema,
  TargetingRuleSchema,
  VariantSchema,
} from "./leaf-schemas-flag";

/**
 * Canonical Zod leaf schemas for the experiment-side glossary nouns.
 * Source of truth: docs/spec/contracts/leaf-schemas-experiment.md
 *
 * Every envelope (request, response, storage) composes these leaves and never
 * redefines them. Any field addition here propagates automatically.
 *
 * The Run LEAF carries ONLY canonical leaf fields. Storage-only/decision columns
 * (run_number, horizon, target_n, sample_size_locked, decision_family,
 * guardrail_decisions, targeting_key_field, start_reason, end_reason,
 * confidence_level) live ONLY on the D1 runs table (S09) — single authoring
 * point — and are deliberately absent here.
 */

// ---------------------------------------------------------------------------
// ExperimentStatus
// ---------------------------------------------------------------------------

export const experimentStatuses = ["draft", "running", "ended", "archived"] as const;

export const ExperimentStatusSchema = z.enum(experimentStatuses);
export type ExperimentStatus = z.infer<typeof ExperimentStatusSchema>;

// ---------------------------------------------------------------------------
// RunStatus
// ---------------------------------------------------------------------------

// Pause lives on Experiment.status, so a Run is only ever running or ended.
export const runStatuses = ["running", "ended"] as const;

export const RunStatusSchema = z.enum(runStatuses);
export type RunStatus = z.infer<typeof RunStatusSchema>;

// ---------------------------------------------------------------------------
// MetricKind
// ---------------------------------------------------------------------------

export const metricKinds = ["binomial", "count", "revenue", "ratio"] as const;

export const MetricKindSchema = z.enum(metricKinds);
export type MetricKind = z.infer<typeof MetricKindSchema>;

// ---------------------------------------------------------------------------
// MetricRef
// ---------------------------------------------------------------------------

export const MetricRefSchema = z.object({
  metricId: z.string(),
});
export type MetricRef = z.infer<typeof MetricRefSchema>;

// ---------------------------------------------------------------------------
// Metric
//
// `eventFieldName` is required for count/revenue (the field summed per Entity);
// `denominator` is required for ratio (numerator/denominator per Entity). Both
// are otherwise null. Conditionals are enforced loudly at parse time.
//
// `winsorize`, `winsorizePct`, `cuped`, and `cupedCoverageThresholdPct` are the
// per-Metric variance-reduction knobs from variance-reduction.md. Null means "engine
// default" and is stored as null rather than as the default value, so a later
// change to the default reaches Metrics that never stated a preference. Run
// Start freezes the resolved values, which is what makes a re-analysis
// reproducible.
// ---------------------------------------------------------------------------

const BaseMetricSchema = z.object({
  id: z.string(),
  appId: z.string(),
  key: z.string(),
  name: z.string(),
  description: z.string().optional(),
  kind: MetricKindSchema,
  eventDefinitionId: z.string().nullable().optional(),
  eventFieldName: z.string().nullable().optional(),
  numerator: MetricRefSchema.nullable().optional(),
  denominator: MetricRefSchema.nullable().optional(),
  configurationStatus: z.enum(["ready", "needs_configuration"]).optional(),
  downsideThresholdPct: z.number().nullable().optional(),
  winsorize: z.boolean().nullable().optional(),
  winsorizePct: z.number().gt(0).max(100).nullable().optional(),
  cuped: z.boolean().nullable().optional(),
  cupedCoverageThresholdPct: z.number().gt(0).max(100).nullable().optional(),
  createdAt: z.string(),
});

export const MetricSchema = BaseMetricSchema.refine(
  (m) => {
    if (m.kind === "count" || m.kind === "revenue") {
      return typeof m.eventFieldName === "string";
    }
    return true;
  },
  { message: "metric kind 'count' / 'revenue' requires eventFieldName" },
)
  .refine((m) => m.kind === "ratio" || typeof m.eventDefinitionId === "string", {
    message: "non-ratio metric requires eventDefinitionId",
  })
  .refine(
    (m) =>
      m.kind === "count" ||
      m.kind === "revenue" ||
      m.eventFieldName == null ||
      isLegacyRatioMetric(m),
    { message: "binomial and ratio metrics cannot carry eventFieldName" },
  )
  .refine(
    (m) =>
      m.kind !== "ratio" ||
      (m.eventDefinitionId == null && m.eventFieldName == null) ||
      isLegacyRatioMetric(m),
    { message: "ratio metric cannot carry a direct Event Definition binding" },
  )
  .refine(
    (m) => {
      if (m.kind === "ratio") {
        return (m.numerator != null && m.denominator != null) || isLegacyRatioMetric(m);
      }
      return true;
    },
    { message: "metric kind 'ratio' requires numerator and denominator" },
  )
  .refine((m) => m.kind !== "ratio" || m.numerator?.metricId !== m.denominator?.metricId, {
    message: "ratio numerator and denominator must be distinct Metrics",
  })
  .refine((m) => m.kind === "ratio" || (m.numerator == null && m.denominator == null), {
    message: "non-ratio metrics cannot carry ratio operands",
  })
  .refine((m) => m.configurationStatus !== "needs_configuration" || isLegacyRatioMetric(m), {
    message: "only an incomplete legacy ratio metric can need configuration",
  });
export type Metric = z.infer<typeof MetricSchema>;

/**
 * A Ratio row written before operands existed: a direct Event Definition
 * binding plus a denominator and no numerator. Such a row is readable but not
 * analysable, which `configurationStatus` reports. Pre-operand writes accepted
 * `eventFieldName` on a Ratio, so a legacy row may carry one; rejecting it here
 * would turn a list read into a 500 with no API path to repair the row.
 */
function isLegacyRatioMetric(metric: z.infer<typeof BaseMetricSchema>): boolean {
  return (
    metric.kind === "ratio" &&
    metric.configurationStatus === "needs_configuration" &&
    typeof metric.eventDefinitionId === "string" &&
    metric.numerator == null &&
    metric.denominator != null
  );
}

// ---------------------------------------------------------------------------
// Experiment
//
// One Experiment controls one Flag (`flagId` is a single string). `targetingKey`
// lives here, not on each Run; Runs inherit it.
// ---------------------------------------------------------------------------

export const ExperimentSchema = z.object({
  id: z.string(),
  appId: z.string(),
  environmentId: z.string(),
  key: z.string(),
  flagId: z.string(),
  name: z.string(),
  description: z.string().optional(),
  hypothesis: z.string().optional(),
  owner: z.string().optional(),
  tags: z.array(z.string()).optional(),
  status: ExperimentStatusSchema,
  targetingKey: z.string(),
  targetingKeyType: z.string(),
  confidenceLevel: z.number(),
  defaultVariantId: z.string(),
  metrics: z.array(MetricRefSchema),
  guardrailMetrics: z.array(MetricRefSchema),
  activationMetricId: z.string().nullable().optional(),
  conversionWindowMs: z.number(),
  dimensions: z.array(z.string()),
  draftAllocation: z.record(z.string(), z.number()).nullable().optional(),
  draftSalt: z.string().nullable().optional(),
  draftTargetingRules: z.array(TargetingRuleSchema).nullable().optional(),
  draftSegmentIds: z.array(z.string()).nullable().optional(),
  // Required field that is null before the first Start.
  liveRunId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Experiment = z.infer<typeof ExperimentSchema>;

// ---------------------------------------------------------------------------
// Run (LEAF)
//
// Assignment config is frozen for the Run's life (ADR-0002, ADR-0003).
// `allocation` is keyed by Variant NAME (not ID) and must sum to 100.
// `variantSet` / `targetingRules` are resolved snapshots frozen at Run creation.
// ---------------------------------------------------------------------------

// Floating-point allocations (e.g. 33.33 x3) never land exactly on 100, so the
// sum is compared within a small epsilon rather than with strict equality.
const ALLOCATION_SUM = 100;
const ALLOCATION_EPSILON = 1e-6;

export const RunSchema = z.object({
  id: z.string(),
  experimentId: z.string(),
  environmentId: z.string(),
  status: RunStatusSchema,
  targetingKeyType: z.string(),
  activationMetricId: z.string().nullable().optional(),
  salt: z.string(),
  // Each share is a percentage in [0, 100] (matching flag-side PercentageRollout),
  // and the shares must sum to 100. Bounding per-share rejects nonsensical splits
  // like {a: 120, b: -20} that net to 100 but contain an out-of-range share.
  allocation: z.record(z.string(), z.number().min(0).max(100)).refine(
    (alloc) => {
      const sum = Object.values(alloc).reduce((acc, n) => acc + n, 0);
      return Math.abs(sum - ALLOCATION_SUM) <= ALLOCATION_EPSILON;
    },
    { message: "allocation percentages must sum to 100" },
  ),
  variantSet: z.array(VariantSchema),
  targetingRules: z.array(ResolvedTargetingRuleSchema),
  configHash: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable().optional(),
  createdAt: z.string(),
});
export type Run = z.infer<typeof RunSchema>;

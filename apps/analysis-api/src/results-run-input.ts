/**
 * Materialize `analysis_run_inputs` rows into StatsInput Run fields.
 *
 * D1 freezes `decision_family` / `guardrail_decisions` as `MetricRef[]`
 * (`{ metricId }`). Tinybird's analysis pipes feed `StatsInputSchema`, which
 * expects snake_case `DecisionFamilyMember[]` / `GuardrailDecision[]`. The
 * Run Snapshot bridge historically copied the D1 JSON verbatim (SPL-302), so
 * production rows arrive as MetricRefs. Accept both shapes; expand MetricRefs
 * against the locked allocation and Control Variant.
 */

import type { StatsInput } from "@splitch/contracts";
import { ResultsInputError, ResultsInsufficientDataError } from "./results-errors";
import {
  compact,
  jsonField,
  optionalNumber,
  optionalString,
  rowObject,
  stringField,
} from "./results-row-fields";

type RunFields = Omit<
  StatsInput,
  "exposures" | "metric_values" | "pre_period_covariates" | "activation_rows"
>;

export function materializeRunInput(row: unknown): RunFields {
  const source = rowObject(row);
  const allocation = parseAllocation(jsonField(source, "allocation"));
  const controlVariant = stringField(source, "control_variant");
  return compact({
    run_id: stringField(source, "run_id"),
    confidence_level: optionalNumber(source.confidence_level),
    horizon: optionalString(source.horizon),
    target_n: optionalNumber(source.target_n),
    sample_size_locked: optionalNumber(source.sample_size_locked),
    allocation,
    control_variant: controlVariant,
    decision_family: materializeDecisionFamily(
      jsonField(source, "decision_family"),
      allocation,
      controlVariant,
    ),
    guardrail_decisions: materializeGuardrailDecisions(
      jsonField(source, "guardrail_decisions") ?? [],
    ),
    dimensions: jsonField(source, "dimensions"),
  }) as RunFields;
}

/**
 * Fail loud when a locked Run is missing the inputs analysis needs. Empty
 * Metric values with a non-empty decision family used to reach StatsEngine as
 * zeros and look like a real result; callers must see the missing input named.
 */
export function assertAnalysisInputsPresent(input: {
  decision_family: readonly unknown[];
  exposures: readonly unknown[];
  metric_values: readonly unknown[];
}): void {
  if (input.exposures.length === 0) {
    throw new ResultsInsufficientDataError("exposures");
  }
  if (input.decision_family.length > 0 && input.metric_values.length === 0) {
    throw new ResultsInsufficientDataError("metric_events");
  }
}

function materializeDecisionFamily(
  raw: unknown,
  allocation: Record<string, number>,
  controlVariant: string,
): StatsInput["decision_family"] {
  if (!Array.isArray(raw)) {
    throw new ResultsInputError("decision_family must be a JSON array");
  }
  if (raw.length === 0) return [];
  if (raw.every(isDecisionFamilyMember)) {
    return raw.map((member) => ({
      metric_id: member.metric_id,
      variant: member.variant,
      ...(member.dimension_id !== undefined ? { dimension_id: member.dimension_id } : {}),
      ...(member.dimension_value !== undefined ? { dimension_value: member.dimension_value } : {}),
    }));
  }
  if (raw.every(isMetricRef)) {
    const treatments = treatmentVariants(allocation, controlVariant);
    if (treatments.length === 0) {
      throw new ResultsInputError(
        "decision_family MetricRefs need at least one non-Control Variant in allocation",
      );
    }
    return raw.flatMap((ref) =>
      treatments.map((variant) => ({ metric_id: ref.metricId, variant })),
    );
  }
  throw new ResultsInputError("decision_family is neither MetricRef[] nor DecisionFamilyMember[]");
}

function materializeGuardrailDecisions(
  raw: unknown,
): NonNullable<StatsInput["guardrail_decisions"]> {
  if (!Array.isArray(raw)) {
    throw new ResultsInputError("guardrail_decisions must be a JSON array");
  }
  if (raw.length === 0) return [];
  if (raw.every(isGuardrailDecision)) {
    return raw.map((row) => ({
      metric_id: row.metric_id,
      variant: row.variant,
      downside_threshold: row.downside_threshold,
      guardrail_locked_at_run_start: row.guardrail_locked_at_run_start,
      threshold_locked_at_run_start: row.threshold_locked_at_run_start,
    }));
  }
  // D1 freezes MetricRefs only; thresholds live on Metric rows and were never
  // copied into the snapshot. Dropping them keeps Results readable; a follow-up
  // must freeze GuardrailDecision at Start. Inventing a threshold would lie.
  if (raw.every(isMetricRef)) {
    return [];
  }
  throw new ResultsInputError("guardrail_decisions is neither MetricRef[] nor GuardrailDecision[]");
}

function parseAllocation(raw: unknown): Record<string, number> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ResultsInputError("allocation must be a JSON object of Variant percentages");
  }
  const allocation: Record<string, number> = {};
  for (const [variant, share] of Object.entries(raw)) {
    if (typeof share !== "number") {
      throw new ResultsInputError(`allocation.${variant} must be a number`);
    }
    allocation[variant] = share;
  }
  return allocation;
}

function treatmentVariants(allocation: Record<string, number>, controlVariant: string): string[] {
  return Object.keys(allocation)
    .filter((variant) => variant !== controlVariant)
    .sort();
}

function isMetricRef(value: unknown): value is { metricId: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { metricId?: unknown }).metricId === "string" &&
    (value as { metric_id?: unknown }).metric_id === undefined
  );
}

function isDecisionFamilyMember(value: unknown): value is {
  metric_id: string;
  variant: string;
  dimension_id?: string | null;
  dimension_value?: string | null;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { metric_id?: unknown }).metric_id === "string" &&
    typeof (value as { variant?: unknown }).variant === "string"
  );
}

function isGuardrailDecision(value: unknown): value is {
  metric_id: string;
  variant: string;
  downside_threshold: number;
  guardrail_locked_at_run_start: boolean;
  threshold_locked_at_run_start: boolean;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { metric_id?: unknown }).metric_id === "string" &&
    typeof (value as { variant?: unknown }).variant === "string" &&
    typeof (value as { downside_threshold?: unknown }).downside_threshold === "number" &&
    typeof (value as { guardrail_locked_at_run_start?: unknown }).guardrail_locked_at_run_start ===
      "boolean" &&
    typeof (value as { threshold_locked_at_run_start?: unknown }).threshold_locked_at_run_start ===
      "boolean"
  );
}

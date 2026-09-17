import {
  type ArmResult,
  type GuardrailResult,
  type Metric,
  MetricVarianceConfigSchema,
  type SignificanceDisplay,
  significanceKey,
} from "@splitch/contracts";
import type {
  PanelExperimentResultsReady,
  PanelExperimentRun,
} from "@splitch/control-plane-sdk/panel-experiments";
import { type MetricNames, metricDisplayName, metricNamesById } from "./metric-names";

/**
 * Row model for the Metric comparison: every Metric the Run measures, grouped
 * by the role the Run froze for it, each Treatment arm read against the
 * baseline. Pure data so the grouping and ordering are testable without markup.
 * No statistic is derived here (ADR-0030): lift, interval and significance all
 * arrive computed.
 */

export type ComparisonMetric = Pick<Metric, "id" | "name" | "kind" | "direction">;

export type MetricComparisonRole = "decision" | "guardrail" | "exploratory";

export type TreatmentComparison = {
  variant: string;
  arm: ArmResult | undefined;
  significance: SignificanceDisplay | undefined;
  guardrail: GuardrailResult | undefined;
};

export type MetricComparisonRow = {
  metricId: string;
  name: string;
  kind: Metric["kind"] | undefined;
  /** Null or undefined both read as neutral: nothing may call a move a win or a loss. */
  direction: Metric["direction"] | undefined;
  control: ArmResult | undefined;
  treatments: TreatmentComparison[];
};

type MetricComparisonGroup = {
  role: MetricComparisonRole;
  rows: MetricComparisonRow[];
};

const ROLE_ORDER: readonly MetricComparisonRole[] = ["decision", "guardrail", "exploratory"];

export function metricComparisonGroups({
  results,
  run,
  metrics,
  baseline,
  variantOrder,
}: {
  results: PanelExperimentResultsReady;
  run: PanelExperimentRun;
  metrics: readonly ComparisonMetric[];
  baseline: string;
  variantOrder: readonly string[];
}): MetricComparisonGroup[] {
  const names = metricNamesById(metrics);
  const treatments = variantOrder.filter((variant) => variant !== baseline);
  const rows = measuredMetricIds(results, run).map((metricId) =>
    comparisonRow(metricId, results, metrics, names, baseline, treatments),
  );
  return ROLE_ORDER.map((role) => ({
    role,
    rows: rows
      .filter((row) => metricRole(row.metricId, run) === role)
      .sort((left, right) => rowMagnitude(right) - rowMagnitude(left)),
  })).filter((group) => group.rows.length > 0);
}

/**
 * The Run's frozen variance config and decision lists name every Metric it
 * measures, so a configured Metric without a result still gets a row. Analysis
 * results are unioned in so nothing the engine measured is silently dropped.
 */
function measuredMetricIds(results: PanelExperimentResultsReady, run: PanelExperimentRun) {
  const frozen = MetricVarianceConfigSchema.array().parse(JSON.parse(run.metricVarianceConfigJson));
  return [
    ...new Set([
      ...frozen.map((metric) => metric.metric_id),
      ...run.decisionMetricIds,
      ...run.decisionGuardrailMetricIds,
      ...results.stats.arm_results.map((result) => result.metric_id),
    ]),
  ];
}

function metricRole(metricId: string, run: PanelExperimentRun): MetricComparisonRole {
  if (run.decisionMetricIds.includes(metricId)) return "decision";
  if (run.decisionGuardrailMetricIds.includes(metricId)) return "guardrail";
  return "exploratory";
}

function comparisonRow(
  metricId: string,
  results: PanelExperimentResultsReady,
  metrics: readonly ComparisonMetric[],
  names: MetricNames,
  baseline: string,
  treatments: readonly string[],
): MetricComparisonRow {
  const arms = results.stats.arm_results.filter((arm) => arm.metric_id === metricId);
  const metric = metrics.find((candidate) => candidate.id === metricId);
  return {
    metricId,
    name: metricDisplayName(metricId, names),
    kind: metric?.kind,
    direction: metric?.direction,
    control: arms.find((arm) => arm.variant === baseline),
    treatments: treatments.map((variant) => {
      const arm = arms.find((candidate) => candidate.variant === variant);
      return {
        variant,
        arm,
        significance: arm ? results.significance[significanceKey(arm)] : undefined,
        guardrail: results.stats.guardrail_results.find(
          (guardrail) => guardrail.metric_id === metricId && guardrail.variant === variant,
        ),
      };
    }),
  };
}

/** Largest relative move across the row's Treatments; rows without one sink. */
function rowMagnitude(row: MetricComparisonRow): number {
  return Math.max(
    Number.NEGATIVE_INFINITY,
    ...row.treatments.map((treatment) =>
      treatment.arm?.relative_lift_pct === null || treatment.arm?.relative_lift_pct === undefined
        ? Number.NEGATIVE_INFINITY
        : Math.abs(treatment.arm.relative_lift_pct),
    ),
  );
}

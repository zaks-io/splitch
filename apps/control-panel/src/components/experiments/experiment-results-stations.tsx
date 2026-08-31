import type { ArmResult, GuardrailResult, SrmTier } from "@splitch/contracts";
import type { PanelExperimentResultsReady } from "@splitch/control-plane-sdk/panel-experiments";
import { Accordion } from "@splitch/ui/components/accordion";
import { armColor } from "#lib/experiments/arm-colors";
import { leadingSignificantResult } from "#lib/experiments/experiment-results-verdict";
import { type MetricNames, metricDisplayName } from "#lib/experiments/metric-names";
import { ExperimentResultsCiPlot } from "./experiment-results-ci-plot";
import { formatLift } from "./experiment-results-format";
import {
  ExperimentResultsGuardrails,
  ExperimentResultsHealth,
  MULTIPLE_RATE_TOLERANCE,
} from "./experiment-results-guardrails";
import { ExperimentResultsMetricsTable } from "./experiment-results-metrics-table";
import { ExperimentResultsSrm } from "./experiment-results-srm";
import { ExperimentResultsStation } from "./experiment-results-station";

export function ExperimentResultsStations({
  results,
  baseline,
  metricNames,
  variantOrder,
}: {
  results: PanelExperimentResultsReady;
  baseline: string;
  metricNames: MetricNames;
  variantOrder: readonly string[];
}) {
  const decisionResults = filteredResults(results.stats.arm_results, baseline, "decision");
  const exploratoryResults = filteredResults(results.stats.arm_results, baseline, "exploratory");
  const exploratoryCount = new Set(
    exploratoryResults
      .filter((result) => result.variant !== baseline)
      .map((result) => result.metric_id),
  ).size;
  const leading = leadingSignificantResult({
    armResults: results.stats.arm_results,
    significance: results.significance,
    baseline,
  });
  const breached = results.stats.guardrail_results.filter(
    (guardrail) => guardrail.is_breached === true,
  );
  const worstTier = srmWorstTier(results);
  const healthPresentation = runHealthPresentation(results, worstTier);
  const decisionPresentation = decisionMetricPresentation(
    decisionResults,
    leading,
    baseline,
    variantOrder,
    metricNames,
  );
  const guardrailPresentation = guardrailsPresentation(
    results.stats.guardrail_results,
    breached,
    results.stats.arm_results,
    metricNames,
  );
  const exploratoryPresentation = exploratoryStationPresentation(exploratoryCount);

  return (
    <Accordion className="w-full" multiple>
      <ExperimentResultsStation
        baseline={baseline}
        {...healthPresentation}
        title="Run health"
        value="health"
        variantOrder={variantOrder}
      >
        <div className="grid gap-5">
          <ExperimentResultsSrm srm={results.srm} stats={results.stats} />
          <ExperimentResultsHealth health={results.stats.health} />
        </div>
      </ExperimentResultsStation>

      <ExperimentResultsStation
        baseline={baseline}
        {...decisionPresentation}
        title="Decision metrics"
        value="decision"
        variantOrder={variantOrder}
      >
        <div className="grid gap-5">
          <p className="text-muted-foreground text-sm">
            Relative lift against {baseline}, with an always-valid confidence sequence.
          </p>
          <ExperimentResultsCiPlot
            control={results.control}
            metricNames={metricNames}
            results={decisionResults}
            significance={results.significance}
          />
          <ExperimentResultsMetricsTable
            control={results.control}
            metricNames={metricNames}
            results={decisionResults}
            significance={results.significance}
          />
        </div>
      </ExperimentResultsStation>

      <ExperimentResultsStation
        baseline={baseline}
        {...guardrailPresentation}
        flaggedVariant={breached[0]?.variant}
        title="Guardrails"
        value="guardrails"
        variantOrder={variantOrder}
      >
        <ExperimentResultsGuardrails
          guardrails={results.stats.guardrail_results}
          metricNames={metricNames}
        />
      </ExperimentResultsStation>

      {exploratoryCount > 0 ? (
        <ExperimentResultsStation
          baseline={baseline}
          {...exploratoryPresentation}
          muted
          siding
          title="Exploratory"
          value="exploratory"
          variantOrder={variantOrder}
        >
          <ExperimentResultsMetricsTable
            control={results.control}
            metricNames={metricNames}
            results={exploratoryResults}
            significance={results.significance}
          />
        </ExperimentResultsStation>
      ) : null}
    </Accordion>
  );
}

function filteredResults(
  results: readonly ArmResult[],
  baseline: string,
  family: "decision" | "exploratory",
): ArmResult[] {
  return results.filter(
    (result) =>
      result.variant === baseline ||
      (family === "decision" ? result.in_bh_family : result.exploratory),
  );
}

type StationPresentation = {
  count: string;
  keyValue: string;
  keyValueStyle?: React.CSSProperties;
  keyValueTone?: string;
  summary: string;
  warnings?: readonly string[];
};

function runHealthPresentation(
  results: PanelExperimentResultsReady,
  tier: SrmTier,
): StationPresentation {
  const firing = healthFiringSignals(results, tier);
  const destructive = tier === "confirmed" || results.control.state !== "frozen";
  // Control identity, exposure SRM, multiple-assignment rate, low-n, plus the
  // two activation diagnostics only when this Run measures them.
  const checkCount = 4 + (results.srm.activated ? 1 : 0) + (results.srm.activationBalance ? 1 : 0);
  return {
    count: `${checkCount} checks`,
    keyValue: `${firing.length} firing`,
    keyValueTone:
      firing.length > 0
        ? destructive
          ? "text-destructive"
          : "text-warning-foreground"
        : "text-success-foreground",
    summary: firing[0] ?? "Assignment and Run health checks pass.",
  };
}

function decisionMetricPresentation(
  results: readonly ArmResult[],
  leading: ArmResult | null,
  baseline: string,
  variantOrder: readonly string[],
  metricNames: MetricNames,
): StationPresentation {
  const count = results.filter((result) => result.variant !== baseline).length;
  if (!leading) {
    return {
      count: `${count} ${count === 1 ? "comparison" : "comparisons"}`,
      keyValue: "–",
      summary: "No significance call yet.",
    };
  }
  return {
    count: `${count} ${count === 1 ? "comparison" : "comparisons"}`,
    keyValue: formatLift(leading.relative_lift_pct),
    keyValueStyle: { color: armColor({ baseline, variant: leading.variant, variantOrder }) },
    summary: `${leading.variant} moves ${metricDisplayName(leading.metric_id, metricNames)}, significant.`,
  };
}

function guardrailsPresentation(
  guardrails: readonly GuardrailResult[],
  breached: readonly GuardrailResult[],
  armResults: readonly ArmResult[],
  metricNames: MetricNames,
): StationPresentation {
  const count = guardrails.length;
  const countLabel = `${count} ${count === 1 ? "check" : "checks"}`;
  if (breached.length === 0) {
    return {
      count: countLabel,
      keyValue: "0 breached",
      keyValueTone: "text-success-foreground",
      summary: "All within threshold.",
    };
  }
  return {
    count: countLabel,
    keyValue: guardrailKeyValue(breached[0], armResults),
    keyValueTone: "text-warning-foreground",
    summary: `${breached.length} of ${count} breached.`,
    warnings: breached.map((guardrail) => guardrailWarning(guardrail, armResults, metricNames)),
  };
}

function exploratoryStationPresentation(count: number): StationPresentation {
  return {
    count: `${count} ${count === 1 ? "metric" : "metrics"}`,
    keyValue: `${count} uncorrected`,
    summary: "Uncorrected hypotheses, never ship evidence.",
  };
}

function srmWorstTier(results: PanelExperimentResultsReady): SrmTier {
  const tiers = [
    results.srm.exposure.tier,
    results.srm.activated?.tier,
    results.srm.activationBalance?.tier,
  ];
  if (tiers.includes("confirmed")) return "confirmed";
  if (tiers.includes("possible_imbalance")) return "possible_imbalance";
  return "clean";
}

/** Worst first: the summary line names signals[0]. */
function healthFiringSignals(results: PanelExperimentResultsReady, tier: SrmTier): string[] {
  const signals: string[] = [];
  if (results.control.state !== "frozen") signals.push("Control identity is not frozen.");
  if (tier === "confirmed") signals.push("Sample Ratio Mismatch is firing.");
  if (tier === "possible_imbalance") signals.push("Assignment balance needs attention.");
  if (results.stats.health.multiple_rate > MULTIPLE_RATE_TOLERANCE)
    signals.push("Multiple assignment is outside tolerance.");
  if (results.stats.health.low_n_warning) signals.push("The engine raised a low-n warning.");
  return signals;
}

function guardrailKeyValue(
  guardrail: GuardrailResult | undefined,
  armResults: readonly ArmResult[],
): string {
  if (!guardrail) throw new Error("A breached Guardrail was counted but not found");
  const result = findGuardrailArmResult(guardrail, armResults);
  return result?.relative_lift_pct === null || result?.relative_lift_pct === undefined
    ? formatPercent(guardrail.ci_lower)
    : formatLift(result.relative_lift_pct);
}

function guardrailWarning(
  guardrail: GuardrailResult,
  armResults: readonly ArmResult[],
  metricNames: MetricNames,
): string {
  const result = findGuardrailArmResult(guardrail, armResults);
  const threshold = formatPercent(guardrail.threshold);
  const metric = metricDisplayName(guardrail.metric_id, metricNames);
  if (result?.relative_lift_pct === null || result?.relative_lift_pct === undefined) {
    return `${metric} on ${guardrail.variant} has CI lower bound ${formatPercent(guardrail.ci_lower)} against a ${threshold} threshold. Concluding now ships a known regression.`;
  }
  return `${metric} on ${guardrail.variant} is ${formatLift(result.relative_lift_pct)} against a ${threshold} threshold. Concluding now ships a known regression.`;
}

function findGuardrailArmResult(
  guardrail: GuardrailResult,
  armResults: readonly ArmResult[],
): ArmResult | undefined {
  return armResults.find(
    (result) => result.metric_id === guardrail.metric_id && result.variant === guardrail.variant,
  );
}

function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "unbounded";
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

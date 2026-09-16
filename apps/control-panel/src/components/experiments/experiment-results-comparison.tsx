import type {
  PanelExperimentResultsReady,
  PanelExperimentRun,
} from "@splitch/control-plane-sdk/panel-experiments";
import { armColor } from "#lib/experiments/arm-colors";
import {
  type ComparisonMetric,
  type MetricComparisonRole,
  metricComparisonGroups,
} from "#lib/experiments/metric-comparison-rows";
import { ExperimentResultsRails, RESULTS_RAIL_GRID } from "./experiment-results-arms";
import { ExperimentResultsLiftAxis } from "./experiment-results-comparison-lift-bar";
import { ArmDot, ExperimentResultsComparisonRow } from "./experiment-results-comparison-row";

export type { ComparisonMetric } from "#lib/experiments/metric-comparison-rows";

const ROLE_TITLES: Record<MetricComparisonRole, string> = {
  decision: "Decision metrics",
  guardrail: "Guardrails",
  exploratory: "Exploratory",
};

export function ExperimentResultsComparison({
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
}) {
  const groups = metricComparisonGroups({ results, run, metrics, baseline, variantOrder });
  const treatments = variantOrder.filter((variant) => variant !== baseline);
  const multi = treatments.length > 1;
  const [soleTreatment] = treatments;
  return (
    <section aria-labelledby="metric-comparison-heading" className={RESULTS_RAIL_GRID}>
      <ExperimentResultsRails baseline={baseline} variantOrder={variantOrder} connect />
      <div className="min-w-0 pb-8">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="font-semibold text-base text-foreground" id="metric-comparison-heading">
            Metric comparison
          </h3>
          <p className="text-muted-foreground text-xs">
            {results.dataWatermark ? (
              <>
                Data through{" "}
                <time dateTime={results.dataWatermark}>
                  {new Date(results.dataWatermark).toLocaleString("en-US", { timeZone: "UTC" })} UTC
                </time>
              </>
            ) : (
              "Data freshness unavailable"
            )}
          </p>
        </div>
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <table className="w-full min-w-[46rem] table-fixed text-sm">
            <colgroup>
              <col className={multi ? "w-52" : "w-64"} />
              {multi ? <col className="w-40" /> : null}
              <col className={multi ? "w-24" : "w-56"} />
              <col />
              <col className="w-28" />
            </colgroup>
            <caption className="sr-only">
              Relative difference from {baseline} per Metric with its confidence interval, grouped
              by the role each Metric plays in the decision
            </caption>
            <thead>
              <tr className="text-muted-foreground text-xs">
                <th scope="col" className="px-4 py-2.5 text-left align-middle font-medium">
                  Metric
                </th>
                {multi ? (
                  <th scope="col" className="px-2 py-2.5 text-left align-middle font-medium">
                    Treatment
                  </th>
                ) : null}
                <th
                  scope="col"
                  className="whitespace-nowrap px-2 py-2.5 text-right align-middle font-medium"
                >
                  {multi || soleTreatment === undefined ? null : (
                    <span className="mr-1 inline-flex items-center gap-1.5 text-foreground">
                      <ArmDot
                        color={armColor({ baseline, variant: soleTreatment, variantOrder })}
                      />
                      {soleTreatment}
                    </span>
                  )}
                  vs {baseline}
                </th>
                <th scope="col" className="px-4 py-2.5 align-middle font-medium">
                  <ExperimentResultsLiftAxis />
                </th>
                <th scope="col" className="px-4 py-2.5 align-middle font-medium">
                  <span className="sr-only">Verdict</span>
                </th>
              </tr>
            </thead>
            {groups.map((group) => (
              <tbody key={group.role}>
                <tr className="border-border border-t bg-muted/40">
                  <th
                    className="px-4 py-1.5 text-left font-medium text-muted-foreground text-xs"
                    colSpan={multi ? 5 : 4}
                    scope="colgroup"
                  >
                    {ROLE_TITLES[group.role]}
                  </th>
                </tr>
                {group.rows.map((row) => (
                  <ExperimentResultsComparisonRow
                    baseline={baseline}
                    key={row.metricId}
                    row={row}
                    variantOrder={variantOrder}
                  />
                ))}
              </tbody>
            ))}
          </table>
        </div>
        <p className="mt-3 text-muted-foreground text-xs">
          Current estimates, including inconclusive results. The band is the confidence interval on
          a fixed -100% to +100% axis, solid when significant, faded when not; an arrow head means
          it runs past the axis. Hover a band for its bounds. Under each Metric, the recorded values
          read baseline to treatment with the absolute difference, in percentage points for rates
          and recorded units otherwise. Rows within a group are ordered by the size of the move.
        </p>
      </div>
    </section>
  );
}

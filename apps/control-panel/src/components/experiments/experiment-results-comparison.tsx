import { type Metric, MetricVarianceConfigSchema } from "@splitch/contracts";
import type {
  PanelExperimentResultsReady,
  PanelExperimentRun,
} from "@splitch/control-plane-sdk/panel-experiments";
import { Fragment } from "react";
import { armColor } from "#lib/experiments/arm-colors";
import { metricDisplayName, metricNamesById } from "#lib/experiments/metric-names";
import { ExperimentResultsRails, RESULTS_RAIL_GRID } from "./experiment-results-arms";

import { ExperimentResultsComparisonValue } from "./experiment-results-comparison-value";

export type ComparisonMetric = Pick<Metric, "id" | "name"> & Partial<Pick<Metric, "kind">>;

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
  const frozenMetrics = MetricVarianceConfigSchema.array().parse(
    JSON.parse(run.metricVarianceConfigJson),
  );
  const metricIds = [
    ...new Set([
      ...frozenMetrics.map((metric) => metric.metric_id),
      ...run.decisionMetricIds,
      ...run.decisionGuardrailMetricIds,
      ...results.stats.arm_results.map((result) => result.metric_id),
    ]),
  ];
  const names = metricNamesById(metrics);
  const variants = [baseline, ...variantOrder.filter((variant) => variant !== baseline)];
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
          <table className="w-full text-sm">
            <caption className="sr-only">
              Current estimates by Variant and absolute differences from {baseline}
            </caption>
            <thead>
              <tr className="text-muted-foreground text-xs">
                <th scope="col" className="px-4 py-3 text-left font-medium">
                  Metric
                </th>
                {variants.map((variant) => (
                  <Fragment key={variant}>
                    <th scope="col" className="min-w-36 px-4 py-3 text-right font-medium">
                      <span className="inline-flex items-center gap-2">
                        <span
                          aria-hidden="true"
                          className="size-2 shrink-0 rounded-full"
                          style={{ backgroundColor: armColor({ baseline, variant, variantOrder }) }}
                        />
                        {variant}
                      </span>
                      {variant === baseline ? (
                        <span className="block font-normal">Baseline</span>
                      ) : null}
                    </th>
                    {variant !== baseline ? (
                      <th scope="col" className="min-w-36 px-4 py-3 text-right font-medium">
                        Difference<span className="block font-normal">vs {baseline}</span>
                      </th>
                    ) : null}
                  </Fragment>
                ))}
              </tr>
            </thead>
            <tbody>
              {metricIds.map((metricId) => {
                const kind = metrics.find((metric) => metric.id === metricId)?.kind;
                const arms = results.stats.arm_results.filter((arm) => arm.metric_id === metricId);
                const control = arms.find((arm) => arm.variant === baseline);
                return (
                  <tr key={metricId} className="border-border border-t">
                    <th
                      scope="row"
                      className="min-w-48 px-4 py-3 text-left font-medium text-foreground"
                    >
                      {metricDisplayName(metricId, names)}
                    </th>
                    {variants.map((variant) => {
                      const arm = arms.find((candidate) => candidate.variant === variant);
                      return (
                        <Fragment key={variant}>
                          <ExperimentResultsComparisonValue arm={arm} kind={kind} />
                          {variant !== baseline ? (
                            <ExperimentResultsComparisonValue
                              arm={arm}
                              kind={kind}
                              control={control}
                              difference
                            />
                          ) : null}
                        </Fragment>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-muted-foreground text-xs">
          Current analysis estimates, including inconclusive results. Differences are absolute, in
          percentage points for percentages and recorded units otherwise. Confidence intervals and
          relative lift are below.
        </p>
      </div>
    </section>
  );
}

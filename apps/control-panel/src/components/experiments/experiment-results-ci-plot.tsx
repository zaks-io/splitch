import type {
  ArmResult,
  ExperimentSignificanceDisplays,
  FrozenControlIdentity,
} from "@splitch/contracts";
import { significanceKey } from "@splitch/contracts";
import {
  type CiPlotDomain,
  ciPlotDomain,
  ciPlotTicks,
  ciPlotX,
} from "#lib/experiments/ci-plot-scale";
import {
  AXIS_HEIGHT,
  LABEL_WIDTH,
  PLOT_WIDTH,
  ROW_HEIGHT,
  TOP_PAD,
  VALUE_WIDTH,
} from "./experiment-results-ci-plot-geometry";
import { ArmRow, BaselineRow } from "#components/experiments/experiment-results-ci-plot-rows";
import { analysisControlVariant } from "#components/experiments/experiment-results-control";
import type { MetricNames } from "#lib/experiments/metric-names";

/**
 * Per-arm lift with its Confidence Interval, rendered for every Run state.
 *
 * This plot is never hidden by an SRM or Guardrail warning: rigor is enforced on
 * the decision, not on the number, and an operator debugging a firing SRM needs
 * these numbers most. Identity lives on the row label as well as in colour, so
 * the reading never depends on colour alone.
 */

export function ExperimentResultsCiPlot({
  results,
  control,
  metricNames,
  significance,
}: {
  results: ArmResult[];
  control: FrozenControlIdentity;
  metricNames: MetricNames;
  significance: ExperimentSignificanceDisplays;
}) {
  const analysisControl = analysisControlVariant(control);
  if (results.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No per-arm result has been produced for this Run yet.
      </p>
    );
  }
  // Legend (and only the legend) claims a zero-lift baseline when a matching
  // arm is actually drawn. An Analysis Control name with no ArmResult is missing
  // data, not a cosmetic gap.
  const baselineDrawn = results.some((result) => result.variant === analysisControl);
  const domain = ciPlotDomain(
    results.map((result) => ({
      estimate: result.relative_lift_pct,
      lower: result.ci_lower,
      upper: result.ci_upper,
    })),
  );
  const height = TOP_PAD + results.length * ROW_HEIGHT + AXIS_HEIGHT;
  const totalWidth = LABEL_WIDTH + PLOT_WIDTH + VALUE_WIDTH;
  const zeroX = LABEL_WIDTH + ciPlotX(0, domain, PLOT_WIDTH);

  return (
    <figure className="m-0">
      <figcaption className="sr-only">
        Relative lift and confidence interval per Variant, against {analysisControl}.
      </figcaption>
      <div className="overflow-x-auto">
        <svg
          aria-label={`Relative lift with confidence intervals against ${analysisControl}`}
          className="h-auto w-full min-w-[44rem]"
          role="img"
          viewBox={`0 0 ${totalWidth} ${height}`}
        >
          <Ticks domain={domain} height={height} />
          <line
            className="stroke-[color:var(--arm-control)]"
            strokeWidth={2}
            x1={zeroX}
            x2={zeroX}
            y1={TOP_PAD - 4}
            y2={TOP_PAD + results.length * ROW_HEIGHT}
          />
          {results.map((result, index) =>
            result.variant === analysisControl ? (
              <BaselineRow
                index={index}
                key={`${result.metric_id}:${result.variant}`}
                metricNames={metricNames}
                result={result}
                zeroX={zeroX}
              />
            ) : (
              <ArmRow
                display={significance[significanceKey(result)]}
                domain={domain}
                index={index}
                key={`${result.metric_id}:${result.variant}`}
                metricNames={metricNames}
                result={result}
              />
            ),
          )}
          <text
            className="fill-muted-foreground font-mono text-[12px]"
            textAnchor="middle"
            x={LABEL_WIDTH + PLOT_WIDTH / 2}
            y={height - 5}
          >
            relative lift vs {analysisControl} (%)
          </text>
        </svg>
      </div>
      <Legend baseline={analysisControl} baselineDrawn={baselineDrawn} />
    </figure>
  );
}

function Ticks({ domain, height }: { domain: CiPlotDomain; height: number }) {
  return (
    <g>
      {ciPlotTicks(domain).map((tick) => {
        const x = LABEL_WIDTH + ciPlotX(tick, domain, PLOT_WIDTH);
        return (
          <g key={tick}>
            <line
              className="stroke-border"
              strokeWidth={1}
              x1={x}
              x2={x}
              y1={TOP_PAD - 4}
              y2={height - AXIS_HEIGHT}
            />
            <text
              className="fill-muted-foreground font-mono text-[11px]"
              textAnchor="middle"
              x={x}
              y={height - AXIS_HEIGHT + 16}
            >
              {tick}
            </text>
          </g>
        );
      })}
    </g>
  );
}

function Legend({ baseline, baselineDrawn }: { baseline: string; baselineDrawn: boolean }) {
  const baselineLegend = baselineDrawn
    ? `Baseline (${baseline}) at zero lift by definition`
    : `Baseline (${baseline}) Variant is missing from these results`;

  return (
    <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-muted-foreground text-xs">
      <li className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className="inline-block size-2.5 rounded-full bg-[color:var(--arm-control)]"
        />
        {baselineLegend}
      </li>
      <li className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className="inline-block size-2.5 rounded-full bg-[color:var(--arm-treatment-foreground)]"
        />
        Treatment lift, filled when the Run's significance call is affirmative
      </li>
      <li className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className="inline-block size-2.5 rounded-full border-2 border-[color:var(--arm-treatment-foreground)]"
        />
        No affirmative significance call (not significant, or disputed)
      </li>
    </ul>
  );
}

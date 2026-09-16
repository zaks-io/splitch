import type { ArmResult, Metric, SignificanceDisplay } from "@splitch/contracts";
import { Badge } from "@splitch/ui/components/badge";
import { armColor } from "#lib/experiments/arm-colors";
import type {
  MetricComparisonRow,
  TreatmentComparison,
} from "#lib/experiments/metric-comparison-rows";
import { type MoveTone, moveTone } from "#lib/experiments/metric-move-tone";
import {
  comparisonUnavailableReason,
  formatAbsoluteDifference,
  formatComparisonEstimate,
} from "./experiment-results-comparison-format";
import { ExperimentResultsLiftBar } from "./experiment-results-comparison-lift-bar";
import { formatLift } from "./experiment-results-format";

/**
 * One line per Treatment of a Metric. The relative difference is the one loud
 * number; the band beside it is the confidence interval; the recorded values
 * sit under the name in the quiet tier. Green and red come only from the
 * Metric's own stated direction, and a breached Guardrail keeps the warning
 * treatment every other Results surface gives it.
 */

export function ExperimentResultsComparisonRow({
  row,
  baseline,
  variantOrder,
}: {
  row: MetricComparisonRow;
  baseline: string;
  variantOrder: readonly string[];
}) {
  const span = row.treatments.length;
  return row.treatments.map((treatment, index) => {
    const breached = treatment.guardrail?.is_breached === true;
    return (
      <tr
        className={`border-border border-t ${breached ? "bg-warning-muted/40" : ""}`}
        key={treatment.variant}
      >
        {index === 0 ? <MetricCell row={row} span={span} /> : null}
        {span > 1 ? (
          <td className="px-2 py-2.5 align-middle text-xs">
            <span className="flex items-center gap-1.5 truncate text-foreground">
              <ArmDot color={armColor({ baseline, variant: treatment.variant, variantOrder })} />
              {treatment.variant}
            </span>
            <span className="block font-mono text-muted-foreground tabular-nums">
              <TreatmentValue control={row.control} kind={row.kind} treatment={treatment.arm} />
            </span>
          </td>
        ) : null}
        <Difference
          baseline={baseline}
          kind={row.kind}
          name={row.name}
          direction={row.direction}
          treatment={treatment}
          variantOrder={variantOrder}
        />
      </tr>
    );
  });
}

export function ArmDot({ color }: { color: string }) {
  return (
    <span
      aria-hidden="true"
      className="size-2 shrink-0 rounded-full"
      style={{ backgroundColor: color }}
    />
  );
}

/** The Metric name, with the recorded values beneath it, spans every Treatment row. */
function MetricCell({ row, span }: { row: MetricComparisonRow; span: number }) {
  return (
    <th className="px-4 py-2.5 text-left align-middle font-medium text-foreground" rowSpan={span}>
      {row.name}
      <span className="mt-0.5 block font-normal text-muted-foreground text-xs">
        <RecordedValues row={row} />
        {row.direction ? null : (
          <span className="ml-2 text-muted-foreground/70">no direction set</span>
        )}
      </span>
    </th>
  );
}

/** Baseline value, and for a single Treatment the move in recorded units beside it. */
function RecordedValues({ row }: { row: MetricComparisonRow }) {
  const reason = comparisonUnavailableReason(row.control, row.kind);
  if (reason || !row.control || !row.kind) return <span>{reason}</span>;
  const treatment = row.treatments.length === 1 ? row.treatments[0]?.arm : undefined;
  return (
    <span className="font-mono tabular-nums">
      {formatComparisonEstimate(row.control.point_estimate, row.kind)}
      {treatment ? (
        <>
          {" → "}
          <TreatmentValue control={row.control} kind={row.kind} treatment={treatment} />
        </>
      ) : null}
    </span>
  );
}

function TreatmentValue({
  control,
  kind,
  treatment,
}: {
  control: ArmResult | undefined;
  kind: Metric["kind"] | undefined;
  treatment: ArmResult | undefined;
}) {
  const reason = comparisonUnavailableReason(treatment, kind);
  if (reason || !treatment || !kind) return <>{reason}</>;
  return (
    <>
      {formatComparisonEstimate(treatment.point_estimate, kind)}
      {control && !comparisonUnavailableReason(control, kind) ? (
        <span className="ml-1.5">({formatAbsoluteDifference(treatment, control, kind)})</span>
      ) : null}
    </>
  );
}

function Difference({
  baseline,
  direction,
  kind,
  name,
  treatment,
  variantOrder,
}: {
  baseline: string;
  direction: Metric["direction"] | undefined;
  kind: Metric["kind"] | undefined;
  name: string;
  treatment: TreatmentComparison;
  variantOrder: readonly string[];
}) {
  const reason = comparisonUnavailableReason(treatment.arm, kind);
  if (reason || !treatment.arm) {
    return (
      <td className="px-4 py-2.5 text-muted-foreground text-xs" colSpan={3}>
        {reason}
      </td>
    );
  }
  const arm = treatment.arm;
  const breached = treatment.guardrail?.is_breached === true;
  const tone = moveTone({ direction, lift: arm.relative_lift_pct, breached });
  const color =
    TONE_COLOR[tone] ?? armColor({ baseline, variant: treatment.variant, variantOrder });
  return (
    <>
      <td
        className={`whitespace-nowrap px-2 py-2.5 text-right align-middle font-medium font-mono tabular-nums ${liftClass(arm, tone)}`}
      >
        {formatLift(arm.relative_lift_pct)}
      </td>
      <td className="px-4 py-2.5 align-middle">
        {arm.status === "error" ? (
          <span className="text-muted-foreground text-xs">Confidence interval unavailable</span>
        ) : (
          <ExperimentResultsLiftBar
            arm={arm}
            color={color}
            decided={treatment.significance === "significant"}
            guardrail={treatment.guardrail}
            label={`${name}, ${treatment.variant}`}
          />
        )}
      </td>
      <td className="px-4 py-2.5 text-right align-middle">
        <Verdict breached={breached} significance={treatment.significance} />
      </td>
    </>
  );
}

/** Undefined keeps the arm colour: a neutral move is identity, not a verdict. */
const TONE_COLOR: Record<MoveTone, string | undefined> = {
  good: "var(--success)",
  bad: "var(--destructive)",
  breached: "var(--warning)",
  neutral: undefined,
};

const TONE_TEXT: Record<MoveTone, string> = {
  good: "text-success-foreground",
  bad: "text-destructive",
  breached: "text-warning-foreground",
  neutral: "text-foreground",
};

function liftClass(arm: ArmResult, tone: MoveTone): string {
  if (arm.relative_lift_pct === null) return "text-muted-foreground text-xs";
  return `text-base ${TONE_TEXT[tone]}`;
}

/**
 * Never asserts significance the drawn interval contradicts: when the engine
 * decided on a different scale than the one shown, the row says so rather
 * than picking a side (ADR-0014, ADR-0036).
 */
function Verdict({
  breached,
  significance,
}: {
  breached: boolean;
  significance: SignificanceDisplay | undefined;
}) {
  if (breached) {
    return (
      <span className="inline-flex rounded-md border border-warning/40 bg-warning-muted px-2 py-0.5 font-medium text-warning-foreground text-xs">
        Breached
      </span>
    );
  }
  if (significance === "inconsistent") {
    return (
      <Badge
        title="The engine flagged this result significant, but the interval shown here contains zero. The two were computed on different scales; do not decide on this row."
        variant="destructive"
      >
        Disputed
      </Badge>
    );
  }
  if (significance === "significant") return <Badge variant="secondary">Significant</Badge>;
  return null;
}

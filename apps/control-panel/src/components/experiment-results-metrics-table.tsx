import type { ArmResult } from "@splitch/contracts";
import { Badge } from "@splitch/ui/components/badge";
import {
  formatInterval,
  formatLift,
  formatPValue,
  significanceDisplay,
} from "./experiment-results-format";

/**
 * The table view of the same arms the plot draws, so identity and value are
 * never colour-only. Every row states whether it belongs to the FDR-corrected
 * decision family or is exploratory, because a corrected and an uncorrected
 * p-value do not mean the same thing and must never look the same.
 */

export function ExperimentResultsMetricsTable({
  results,
  controlVariant,
}: {
  results: ArmResult[];
  controlVariant: string;
}) {
  if (results.length === 0) return null;
  return (
    <section aria-labelledby="results-table-heading" className="grid gap-2">
      <h3 className="font-semibold text-base text-foreground" id="results-table-heading">
        Metric results
      </h3>
      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full min-w-[46rem] text-sm">
          <caption className="sr-only">
            Per-Metric, per-Variant lift with confidence interval, p-value and correction family
          </caption>
          <thead>
            <tr className="text-muted-foreground text-xs">
              <th className="px-4 py-2 text-left font-medium">Metric</th>
              <th className="px-4 py-2 text-left font-medium">Variant</th>
              <th className="px-4 py-2 text-right font-medium">n</th>
              <th className="px-4 py-2 text-right font-medium">Estimate</th>
              <th className="px-4 py-2 text-right font-medium">Lift</th>
              <th className="px-4 py-2 text-right font-medium">Interval</th>
              <th className="px-4 py-2 text-right font-medium">p</th>
              <th className="px-4 py-2 text-left font-medium">Family</th>
            </tr>
          </thead>
          <tbody>
            {results.map((result) => (
              <Row
                controlVariant={controlVariant}
                key={`${result.metric_id}:${result.variant}`}
                result={result}
              />
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-muted-foreground text-xs">
        Corrected rows carry a Benjamini-Hochberg correction across the Run's decision family and
        may be shipped on. Exploratory rows are uncorrected: read them as hypotheses, never as
        evidence. A row that is not decision-valid failed a readiness precondition and cannot
        support a decision at all.
      </p>
    </section>
  );
}

/**
 * The baseline is the thing everything else is measured against, so its lift,
 * interval and p-value are not "not estimable": they do not exist. Printing
 * [−∞, +∞] and p 1.0 there reads as a wildly uncertain result instead of as
 * the anchor the plot correctly draws it as.
 */
function Row({ result, controlVariant }: { result: ArmResult; controlVariant: string }) {
  const isBaseline = result.variant === controlVariant;
  return (
    <tr className="border-border border-t">
      <td className="px-4 py-2 font-mono text-foreground text-xs">{result.metric_id}</td>
      <td className="px-4 py-2 text-foreground">{result.variant}</td>
      <td className="px-4 py-2 text-right font-mono text-foreground">
        {result.sample_size_n.toLocaleString("en-US")}
      </td>
      <td className="px-4 py-2 text-right font-mono text-foreground">
        {result.point_estimate.toPrecision(3)}
      </td>
      {isBaseline ? (
        <>
          <td className="px-4 py-2 text-right font-mono text-foreground">0.0%</td>
          <td className="px-4 py-2 text-right font-mono text-muted-foreground" colSpan={2}>
            baseline, by definition
          </td>
          <td className="px-4 py-2">
            <Badge variant="outline">Baseline</Badge>
          </td>
        </>
      ) : (
        <>
          <td className="px-4 py-2 text-right font-mono text-foreground">
            {formatLift(result.relative_lift_pct)}
          </td>
          <td className="px-4 py-2 text-right font-mono text-muted-foreground">
            {formatInterval(result)}
          </td>
          <td className="px-4 py-2 text-right font-mono text-foreground">
            {formatPValue(result.p_value)}
          </td>
          <td className="px-4 py-2">
            <FamilyBadges result={result} />
          </td>
        </>
      )}
    </tr>
  );
}

function FamilyBadges({ result }: { result: ArmResult }) {
  return (
    <span className="flex flex-wrap gap-1">
      <Badge variant={result.in_bh_family ? "secondary" : "outline"}>
        {result.in_bh_family ? "FDR corrected" : "Exploratory"}
      </Badge>
      {result.decision_valid ? null : <Badge variant="outline">Not decision-valid</Badge>}
      {result.status === "ready" ? null : <Badge variant="outline">{statusLabel(result)}</Badge>}
      <SignificanceBadge result={result} />
    </span>
  );
}

/**
 * Never asserts significance the plotted interval contradicts. When the engine
 * decided on a different scale than the one shown, both readings are reported
 * rather than silently reconciled (ADR-0014, ADR-0036).
 */
function SignificanceBadge({ result }: { result: ArmResult }) {
  const display = significanceDisplay(result);
  if (display === "not_significant") return null;
  if (display === "inconsistent") {
    return (
      <Badge
        title="The engine flagged this result significant, but the interval shown here contains zero. The two were computed on different scales; do not decide on this row."
        variant="destructive"
      >
        Significance disputed
      </Badge>
    );
  }
  return <Badge variant="secondary">Significant</Badge>;
}

function statusLabel(result: ArmResult): string {
  if (result.status === "insufficient_n") return "Insufficient n";
  if (result.status === "insufficient_denominator") return "Insufficient denominator";
  return result.status.charAt(0).toUpperCase() + result.status.slice(1);
}

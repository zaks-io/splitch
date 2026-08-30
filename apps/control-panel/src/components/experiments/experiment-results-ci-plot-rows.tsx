import type { ArmResult, SignificanceDisplay } from "@splitch/contracts";
import { type CiPlotDomain, ciBoundIsOpen, ciPlotX } from "#lib/experiments/ci-plot-scale";
import { LABEL_WIDTH, PLOT_WIDTH, rowY, VALUE_X } from "./experiment-results-ci-plot-geometry";
import { formatInterval, formatLift } from "./experiment-results-format";

/**
 * One row of marks per arm. Colour encodes the arm's role and never its rank:
 * the baseline is cobalt, every Treatment arm is chartreuse. Significance is
 * carried by fill rather than by hue, so the reading survives colour blindness
 * and print.
 */

function RowLabel({ result, y }: { result: ArmResult; y: number }) {
  return (
    <>
      <text className="fill-foreground text-[12px]" x={0} y={y + 4}>
        {result.variant}
      </text>
      <text className="fill-muted-foreground font-mono text-[10px]" x={0} y={y + 15}>
        {result.metric_id}
      </text>
    </>
  );
}

/**
 * The baseline arm sits at zero by construction, so it is drawn as an anchor and
 * never as an interval. The Analysis Worker reports no lift for it, and drawing
 * that absence as an unbounded whisker would claim total uncertainty about the
 * one quantity on this plot that is known exactly.
 */
export function BaselineRow({
  result,
  index,
  zeroX,
}: {
  result: ArmResult;
  index: number;
  zeroX: number;
}) {
  const y = rowY(index);
  return (
    <g>
      <title>{`${result.variant} · ${result.metric_id}: baseline, 0% lift by definition, n=${result.sample_size_n}`}</title>
      <RowLabel result={result} y={y} />
      <circle
        className="fill-[color:var(--arm-control)] stroke-card"
        cx={zeroX}
        cy={y}
        r={5}
        strokeWidth={2}
      />
      <text className="fill-foreground font-mono text-[11px]" x={VALUE_X} y={y + 4}>
        baseline
      </text>
      <text className="fill-muted-foreground font-mono text-[10px]" x={VALUE_X} y={y + 15}>
        0% by definition
      </text>
    </g>
  );
}

export function ArmRow({
  result,
  index,
  domain,
  display,
}: {
  result: ArmResult;
  index: number;
  domain: CiPlotDomain;
  display: SignificanceDisplay | undefined;
}) {
  const y = rowY(index);
  const openLower = ciBoundIsOpen(result.ci_lower);
  const openUpper = ciBoundIsOpen(result.ci_upper);
  const lowerX = LABEL_WIDTH + (openLower ? 0 : ciPlotX(result.ci_lower, domain, PLOT_WIDTH));
  const upperX =
    LABEL_WIDTH + (openUpper ? PLOT_WIDTH : ciPlotX(result.ci_upper, domain, PLOT_WIDTH));
  const estimateX =
    result.relative_lift_pct === null
      ? null
      : LABEL_WIDTH + ciPlotX(result.relative_lift_pct, domain, PLOT_WIDTH);
  // Filled only when the Worker's significance verdict is an unqualified one.
  // A filled dot on an interval that spans zero would assert a decision the
  // picture contradicts (ADR-0014), and the surface never makes that call
  // itself (ADR-0030).
  const decided = display === "significant";

  return (
    <g>
      <title>{armSummary(result)}</title>
      <RowLabel result={result} y={y} />
      <line
        className="stroke-[color:var(--arm-treatment-foreground)]"
        strokeLinecap={openLower || openUpper ? "butt" : "round"}
        strokeWidth={2}
        x1={lowerX}
        x2={upperX}
        y1={y}
        y2={y}
      />
      {[
        { bound: "lower" as const, x: lowerX, open: openLower },
        { bound: "upper" as const, x: upperX, open: openUpper },
      ].map((cap) =>
        cap.open ? (
          // An open end is unbounded, not merely wide. The arrow says the
          // interval runs off the plot rather than stopping at its edge.
          <polyline
            className="fill-none stroke-[color:var(--arm-treatment-foreground)]"
            key={`cap-${cap.bound}`}
            points={openArrowPoints(cap.x, y, cap.bound)}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
          />
        ) : (
          <line
            className="stroke-[color:var(--arm-treatment-foreground)]"
            key={`cap-${cap.bound}`}
            strokeWidth={2}
            x1={cap.x}
            x2={cap.x}
            y1={y - 5}
            y2={y + 5}
          />
        ),
      )}
      {estimateX === null ? null : (
        <circle
          className={
            decided
              ? "fill-[color:var(--arm-treatment-foreground)] stroke-card"
              : "fill-card stroke-[color:var(--arm-treatment-foreground)]"
          }
          cx={estimateX}
          cy={y}
          r={5}
          strokeWidth={2}
        />
      )}
      <text className="fill-foreground font-mono text-[11px]" x={VALUE_X} y={y + 4}>
        {formatLift(result.relative_lift_pct)}
      </text>
      <text className="fill-muted-foreground font-mono text-[10px]" x={VALUE_X} y={y + 15}>
        {formatInterval(result)}
      </text>
    </g>
  );
}

const ARROW_LENGTH = 7;

function openArrowPoints(x: number, y: number, bound: "lower" | "upper"): string {
  const tipDirection = bound === "lower" ? -1 : 1;
  const backX = x - tipDirection * ARROW_LENGTH;
  return `${backX},${y - 5} ${x},${y} ${backX},${y + 5}`;
}

function armSummary(result: ArmResult): string {
  return `${result.variant} · ${result.metric_id}: ${formatLift(result.relative_lift_pct)} lift, ${formatInterval(result)}, n=${result.sample_size_n}`;
}

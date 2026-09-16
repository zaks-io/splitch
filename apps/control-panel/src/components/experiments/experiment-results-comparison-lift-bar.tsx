import type { ArmResult, GuardrailResult } from "@splitch/contracts";
import { formatInterval } from "./experiment-results-format";

/**
 * One Treatment's relative difference against the baseline as a band on an
 * axis that is the same for every row and every Run: -100% to +100%, zero in
 * the middle. A fixed axis is the point. A shared data-driven domain would let
 * one runaway Metric shrink every other row to a sliver, and a per-row domain
 * would make a 1% wobble look exactly like a 90% collapse. The band is the
 * confidence interval; the bounds are spoken only on hover. Values past the
 * edge pin there behind an arrow head, so "off the chart" is a reading of its
 * own rather than a rescaled everything else.
 */

const LIFT_AXIS_LIMIT = 100;
const LIFT_AXIS_TICKS = [-100, -50, 0, 50, 100] as const;

type AxisPosition = { pct: number; open: boolean };

const HEIGHT = 24;
const MID = HEIGHT / 2;
const BAND = 8;
const ARROW = 6;

export function ExperimentResultsLiftBar({
  arm,
  color,
  decided,
  guardrail,
  label,
}: {
  arm: ArmResult;
  color: string;
  decided: boolean;
  guardrail: GuardrailResult | undefined;
  label: string;
}) {
  const interval = intervalFor(arm);
  const estimate = arm.relative_lift_pct === null ? null : position(arm.relative_lift_pct);
  return (
    <svg
      aria-label={`${label}: ${formatInterval(arm)}`}
      className="block w-full"
      height={HEIGHT}
      overflow="visible"
      role="img"
    >
      <title>{`${label}: ${formatInterval(arm)}`}</title>
      <line className="stroke-border" x1="50%" x2="50%" y1={0} y2={HEIGHT} />
      {guardrail ? (
        <line
          className="stroke-warning"
          strokeDasharray="3 3"
          strokeWidth={1.5}
          x1={`${position(guardrail.threshold).pct}%`}
          x2={`${position(guardrail.threshold).pct}%`}
          y1={0}
          y2={HEIGHT}
        />
      ) : null}
      {interval ? <Band color={color} decided={decided} interval={interval} /> : null}
      {estimate ? (
        <rect
          fill={color}
          height={BAND + 8}
          rx={1.5}
          style={{ transform: "translateX(-1.5px)" }}
          width={3}
          x={`${estimate.pct}%`}
          y={MID - (BAND + 8) / 2}
        />
      ) : null}
    </svg>
  );
}

/** The tick row the column header draws once, on the same span as every band. */
export function ExperimentResultsLiftAxis() {
  return (
    <div
      aria-hidden="true"
      className="relative h-4 font-mono font-normal text-[10px] text-muted-foreground"
    >
      {LIFT_AXIS_TICKS.map((tick) => (
        <span
          className="absolute top-0 -translate-x-1/2"
          key={tick}
          style={{ left: `${position(tick).pct}%` }}
        >
          {tick > 0 ? `+${tick}%` : tick === 0 ? "0" : `${tick}%`}
        </span>
      ))}
    </div>
  );
}

/**
 * Solid when the Worker's significance verdict is unqualified, faded when it
 * is not: an interval that spans zero must never look as settled as one that
 * does not (ADR-0014).
 */
function Band({
  color,
  decided,
  interval,
}: {
  color: string;
  decided: boolean;
  interval: { lower: AxisPosition; upper: AxisPosition };
}) {
  const width = Math.max(interval.upper.pct - interval.lower.pct, 0);
  return (
    <g opacity={decided ? 1 : 0.4}>
      <svg
        aria-hidden="true"
        height={BAND}
        overflow="visible"
        preserveAspectRatio="none"
        width={`${width}%`}
        x={`${interval.lower.pct}%`}
        y={MID - BAND / 2}
      >
        <rect fill={color} height={BAND} rx={BAND / 2} width="100%" />
      </svg>
      {interval.lower.open ? <OpenEnd color={color} direction="lower" /> : null}
      {interval.upper.open ? <OpenEnd color={color} direction="upper" /> : null}
    </g>
  );
}

/** An arrow head at the axis edge: the interval runs past what the axis shows. */
function OpenEnd({ color, direction }: { color: string; direction: "lower" | "upper" }) {
  const tip = direction === "lower" ? -ARROW : ARROW;
  return (
    <svg
      aria-hidden="true"
      height={HEIGHT}
      overflow="visible"
      width={1}
      x={direction === "lower" ? "0%" : "100%"}
      y={0}
    >
      <polygon fill={color} points={`${tip},${MID} ${-tip},${MID - BAND} ${-tip},${MID + BAND}`} />
    </svg>
  );
}

/**
 * A band is only drawn for an arm with an estimate to hang it on. Without one,
 * a full-width open band would claim total uncertainty about a number the
 * engine never produced, and a failed interval calculation is named in words.
 */
function intervalFor(arm: ArmResult): { lower: AxisPosition; upper: AxisPosition } | null {
  if (arm.relative_lift_pct === null || arm.status === "error") return null;
  return {
    lower: arm.ci_lower === null ? { pct: 0, open: true } : position(arm.ci_lower),
    upper: arm.ci_upper === null ? { pct: 100, open: true } : position(arm.ci_upper),
  };
}

/**
 * Percent of the axis width for a lift value. Infinite bounds and finite values
 * past the limit both pin to the edge as open, because pinning is the honest
 * picture of "further than this axis shows".
 */
function position(value: number): AxisPosition {
  if (value < -LIFT_AXIS_LIMIT) return { pct: 0, open: true };
  if (value > LIFT_AXIS_LIMIT) return { pct: 100, open: true };
  return { pct: ((value + LIFT_AXIS_LIMIT) / (2 * LIFT_AXIS_LIMIT)) * 100, open: false };
}

/**
 * Pure geometry for the lift / Confidence Interval plot.
 *
 * This is layout math only. No statistic is derived here: every number plotted
 * arrives already computed by the stats engine (ADR-0030).
 */

export interface CiPlotRow {
  /** Relative lift, in percent. Null when the engine could not estimate it. */
  estimate: number | null;
  /** Null bounds are unbounded, not missing: they must render as an open end. */
  lower: number | null;
  upper: number | null;
}

export interface CiPlotDomain {
  min: number;
  max: number;
}

/** Symmetric-ish domain that always contains zero, so the baseline is never off-canvas. */
export function ciPlotDomain(rows: CiPlotRow[]): CiPlotDomain {
  const values = rows
    .flatMap((row) => [row.estimate, row.lower, row.upper])
    .filter((value): value is number => value !== null && Number.isFinite(value));
  if (values.length === 0) return { min: -1, max: 1 };
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const span = max - min;
  const padding = span === 0 ? 1 : span * 0.12;
  return { min: min - padding, max: max + padding };
}

export function ciPlotTicks(domain: CiPlotDomain, target = 5): number[] {
  const span = domain.max - domain.min;
  if (span <= 0) return [0];
  const rawStep = span / Math.max(1, target);
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const step =
    [1, 2, 2.5, 5, 10]
      .map((factor) => factor * magnitude)
      .find((candidate) => candidate >= rawStep) ?? 10 * magnitude;
  const ticks: number[] = [];
  for (let tick = Math.ceil(domain.min / step) * step; tick <= domain.max; tick += step) {
    ticks.push(roundTick(tick, step));
  }
  return ticks.includes(0) ? ticks : [...ticks, 0].sort((left, right) => left - right);
}

/** Maps a lift value to an x offset. Unbounded ends clamp to the plot edge. */
export function ciPlotX(value: number | null, domain: CiPlotDomain, width: number): number {
  if (value === null || !Number.isFinite(value)) return Number.NaN;
  const ratio = (value - domain.min) / (domain.max - domain.min);
  return Math.min(1, Math.max(0, ratio)) * width;
}

/** True when a bound runs off the plot and must be drawn as an open arrow. */
export function ciBoundIsOpen(value: number | null): boolean {
  return value === null || !Number.isFinite(value);
}

function roundTick(value: number, step: number): number {
  const decimals = Math.max(0, -Math.floor(Math.log10(step)) + 1);
  return Number(value.toFixed(decimals));
}

import type { RopeScale } from "@splitch/contracts";

/**
 * Region Of Practical Equivalence (ROPE) verdict for a confidence-sequence
 * interval (Kruschke 2018).
 *
 * Because the interval is an always-valid confidence sequence, the verdict is
 * valid at any look: peeking does not inflate the Type I / equivalence error
 * rates of this classification relative to the sequence's coverage guarantee.
 *
 * Both the interval and the ROPE are closed. A shared boundary point counts as
 * overlap (so it is not `outside`); a point interval on the ROPE boundary is
 * `inside`. The caller must place `lower`/`upper` and `ropeLower`/`ropeUpper`
 * on the same scale (absolute lift or relative lift); this function does not
 * convert scales.
 *
 * Pre-registration (plan 2.2) supplies the ROPE per Metric; metric-arm-rope
 * attaches ropeVerdict on ArmResult only for absolute ROPEs (proven CS).
 * Relative ROPEs surface ropeVerdictUnavailable instead.
 */

export const ROPE_VERDICTS = ["outside", "inside", "undecided"] as const;

export type RopeVerdict = (typeof ROPE_VERDICTS)[number];

export type { RopeScale } from "@splitch/contracts";

export interface RopeVerdictInput {
  readonly lower: number;
  readonly upper: number;
  readonly ropeLower: number;
  readonly ropeUpper: number;
  readonly scale: RopeScale;
}

export function classifyRopeVerdict(input: RopeVerdictInput): RopeVerdict {
  validateRopeVerdictInput(input);

  const { lower, upper, ropeLower, ropeUpper } = input;

  if (lower >= ropeLower && upper <= ropeUpper) {
    return "inside";
  }
  if (upper < ropeLower || lower > ropeUpper) {
    return "outside";
  }
  return "undecided";
}

function validateRopeVerdictInput(input: RopeVerdictInput): void {
  if (input.scale !== "absolute" && input.scale !== "relative") {
    throw new Error(
      `ROPE scale must be "absolute" or "relative"; received ${JSON.stringify(input.scale)}.`,
    );
  }

  assertFiniteBound("lower", input.lower);
  assertFiniteBound("upper", input.upper);
  assertFiniteBound("ropeLower", input.ropeLower);
  assertFiniteBound("ropeUpper", input.ropeUpper);

  if (input.lower > input.upper) {
    throw new Error(
      `confidence-sequence interval lower (${input.lower}) must be <= upper (${input.upper}).`,
    );
  }
  if (input.ropeLower >= input.ropeUpper) {
    throw new Error(
      `ROPE lower (${input.ropeLower}) must be strictly less than ROPE upper (${input.ropeUpper}).`,
    );
  }
}

function assertFiniteBound(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number; received ${String(value)}.`);
  }
}

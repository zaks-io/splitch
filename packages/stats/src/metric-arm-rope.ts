import type { ArmResult, PreRegistration, PreRegistrationRope } from "@splitch/contracts";
import { classifyRopeVerdict } from "./rope-verdict";
import type { CIResult } from "./sequential-ci";

/**
 * Attach ropeVerdict when this Metric pre-registered a ROPE and the decision
 * interval on that ROPE's scale is finite. Absent otherwise — never defaulted.
 */

export function withRopeVerdict(
  arm: ArmResult,
  input: {
    preRegistration: PreRegistration | undefined;
    decisionCi: CIResult | null;
    relativeLower: number | null;
    relativeUpper: number | null;
  },
): ArmResult {
  const rope = ropeForMetric(input.preRegistration, arm.metric_id);
  if (rope === undefined) return arm;
  const interval = intervalForScale(rope, input);
  if (interval === null) return arm;
  return {
    ...arm,
    ropeVerdict: classifyRopeVerdict({
      lower: interval.lower,
      upper: interval.upper,
      ropeLower: rope.lower,
      ropeUpper: rope.upper,
      scale: rope.scale,
    }),
    ropeScale: rope.scale,
  };
}

function ropeForMetric(
  preRegistration: PreRegistration | undefined,
  metricId: string,
): PreRegistrationRope | undefined {
  return preRegistration?.metrics.find((metric) => metric.metric_id === metricId)?.rope;
}

function intervalForScale(
  rope: PreRegistrationRope,
  input: {
    decisionCi: CIResult | null;
    relativeLower: number | null;
    relativeUpper: number | null;
  },
): { lower: number; upper: number } | null {
  if (rope.scale === "absolute") {
    const ci = input.decisionCi;
    if (ci === null || !Number.isFinite(ci.ci_lower) || !Number.isFinite(ci.ci_upper)) {
      return null;
    }
    return { lower: ci.ci_lower, upper: ci.ci_upper };
  }
  if (
    input.relativeLower === null ||
    input.relativeUpper === null ||
    !Number.isFinite(input.relativeLower) ||
    !Number.isFinite(input.relativeUpper)
  ) {
    return null;
  }
  return { lower: input.relativeLower, upper: input.relativeUpper };
}

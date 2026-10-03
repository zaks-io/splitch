import type { ArmResult, PreRegistration, PreRegistrationRope } from "@splitch/contracts";
import { classifyRopeVerdict } from "./rope-verdict";
import type { CIResult } from "./sequential-ci";

/**
 * Attach ropeVerdict when this Metric pre-registered an absolute ROPE and the
 * absolute decision interval is finite. Relative ROPEs cannot claim an
 * always-valid sequential verdict (Fieller coverage unproven); those attach
 * ropeVerdictUnavailable instead of silently omitting. Absent entirely when no
 * ROPE was pre-registered.
 */

export function withRopeVerdict(
  arm: ArmResult,
  input: {
    preRegistration: PreRegistration | undefined;
    decisionCi: CIResult | null;
  },
): ArmResult {
  const rope = ropeForMetric(input.preRegistration, arm.metric_id);
  if (rope === undefined) return arm;
  if (rope.scale === "relative") {
    return {
      ...arm,
      ropeVerdictUnavailable: "relative_sequential_coverage_unproven",
    };
  }
  const interval = absoluteInterval(input.decisionCi);
  if (interval === null) return arm;
  return {
    ...arm,
    ropeVerdict: classifyRopeVerdict({
      lower: interval.lower,
      upper: interval.upper,
      ropeLower: rope.lower,
      ropeUpper: rope.upper,
      scale: "absolute",
    }),
    ropeScale: "absolute",
  };
}

function ropeForMetric(
  preRegistration: PreRegistration | undefined,
  metricId: string,
): PreRegistrationRope | undefined {
  return preRegistration?.metrics.find((metric) => metric.metric_id === metricId)?.rope;
}

function absoluteInterval(decisionCi: CIResult | null): { lower: number; upper: number } | null {
  if (
    decisionCi === null ||
    !Number.isFinite(decisionCi.ci_lower) ||
    !Number.isFinite(decisionCi.ci_upper)
  ) {
    return null;
  }
  return { lower: decisionCi.ci_lower, upper: decisionCi.ci_upper };
}

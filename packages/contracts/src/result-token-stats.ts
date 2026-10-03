import type { ArmResult } from "./stats-result-arm";
import type { StatsOutput } from "./stats-result-contract";

/**
 * The Stats the result token hashes: everything except the estimand disclosure.
 *
 * The disclosure labels and restates the decision-driving estimate without
 * changing it, so leaving it out keeps a Run's result token byte-identical to
 * the token issued before the disclosure existed (result-contracts.md).
 */
export function resultTokenStats(stats: StatsOutput): StatsOutput {
  return {
    ...stats,
    arm_results: stats.arm_results.map(withoutEstimand),
    ...(stats.dimension_results === undefined
      ? {}
      : {
          dimension_results: stats.dimension_results.map((dimension) => ({
            ...dimension,
            arm_results: dimension.arm_results.map(withoutEstimand),
          })),
        }),
  };
}

function withoutEstimand(arm: ArmResult): ArmResult {
  // Classification overlays (ROPE, futility, absolute CI) and estimand disclosure
  // are derived or advisory; stripping them keeps tokens for existing Runs
  // byte-identical to before those fields existed. Decision-bearing relative CI
  // and point estimates stay hashed.
  const {
    estimand: _estimand,
    ropeVerdict: _rope,
    ropeScale: _scale,
    ropeVerdictUnavailable: _unavailable,
    futilityVerdict: _futility,
    futilityBecause: _because,
    absolute_ci_lower: _absLower,
    absolute_ci_upper: _absUpper,
    simultaneous_absolute_ci_lower: _simAbsLower,
    simultaneous_absolute_ci_upper: _simAbsUpper,
    simultaneous_ci_lower: _simLower,
    simultaneous_ci_upper: _simUpper,
    eligible_n: _eligible,
    immature_excluded_n: _immature,
    ...rest
  } = arm;
  return rest;
}

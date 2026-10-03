import type { ArmResult, StatsOutput } from "./stats-result-contract";

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
  // Classification overlays (ROPE, futility) read the already-tokenized
  // decision interval against frozen pre-registration; stripping them keeps
  // tokens for Runs without those fields byte-identical to before they existed.
  const {
    estimand: _estimand,
    ropeVerdict: _rope,
    ropeScale: _scale,
    ropeVerdictUnavailable: _unavailable,
    futilityVerdict: _futility,
    futilityBecause: _because,
    ...rest
  } = arm;
  return rest;
}

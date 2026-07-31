import type { EnvironmentPolicy } from "@splitch/contracts";

/**
 * The one label per gated change type, shared by every surface that names them.
 *
 * `enabledState` gates turning a Flag *on* only: the kill switch turns a Flag off
 * regardless of Policy and is never gated (ADR-0029). A label that reads as
 * "enable / disable" would tell an operator mid-incident that shutting a Flag off
 * needs a confirmation it does not need.
 */
export const ENVIRONMENT_POLICY_LABELS: ReadonlyArray<readonly [keyof EnvironmentPolicy, string]> =
  [
    ["variantAvailability", "Variant availability"],
    ["targetingRolloutValue", "Targeting, rollout, or value"],
    ["enabledState", "Enabled state (turn on)"],
    ["startExperimentRun", "Start an Experiment Run"],
  ];

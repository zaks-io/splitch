import type { FlagConfigGetOutput } from "@splitch/control-plane-sdk";

export type FlagConfigSummary = {
  enabled: boolean;
  availableVariantCount: number;
  rolloutPercentages: number[];
  controllingExperiment: { id: string; name: string } | null;
};

export function flagConfigSummary(config: FlagConfigGetOutput): FlagConfigSummary {
  return {
    enabled: config.enabled,
    availableVariantCount: config.availableVariantNames.length,
    rolloutPercentages: config.targetingRules.flatMap((rule) =>
      rule.percentageRollout ? [rule.percentageRollout.percentage] : [],
    ),
    controllingExperiment: config.experiment,
  };
}

/**
 * An empty available set means the Configuration was never narrowed, so the whole
 * catalog is a candidate rather than an empty serving set.
 */
export function availabilitySummary(availableCount: number, catalogCount: number): string {
  if (availableCount === 0) return `All ${catalogCount}, not narrowed`;
  return `${availableCount} of ${catalogCount}`;
}

export function rolloutSummary(percentages: number[]): string {
  if (percentages.length === 0) return "No percentage rollout";
  const values = percentages.map((percentage) => `${formatPercentage(percentage)}%`).join(", ");
  return `${values} ${percentages.length === 1 ? "rollout" : "rollouts"}`;
}

function formatPercentage(value: number): string {
  return Number.isInteger(value) ? value.toFixed(0) : value.toString();
}

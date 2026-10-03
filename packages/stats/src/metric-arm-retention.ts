import type { ArmResult } from "@splitch/contracts";
import type { MetricArmEstimate } from "./variance-estimator-types";

export function retentionEligibilityFields(
  arm: MetricArmEstimate,
): Pick<ArmResult, "eligible_n" | "immature_excluded_n"> | Record<string, never> {
  if (arm.metric_type !== "retention") return {};
  return {
    eligible_n: arm.sample_size_n,
    immature_excluded_n: arm.immature_excluded_n ?? 0,
  };
}

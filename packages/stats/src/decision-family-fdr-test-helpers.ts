import type { ArmResult, VarianceTechniques } from "@splitch/contracts";

const varianceTechniques: VarianceTechniques = {
  winsorized: false,
  winsorize_pct: null,
  winsorize_cap: null,
  cuped_applied: false,
  cuped_method: null,
  cuped_attribute: null,
  cuped_attribute_source: null,
  cuped_coverage_pct: null,
  delta_method: false,
};

export function armResult(
  metricId: string,
  variant: string,
  pValue: number,
  overrides: Partial<ArmResult> = {},
): ArmResult {
  return {
    variant,
    metric_id: metricId,
    sample_size_n: 1_000,
    point_estimate: 0,
    relative_lift_pct: null,
    ci_lower: null,
    ci_upper: null,
    p_value: pValue,
    is_significant: false,
    in_bh_family: false,
    exploratory: true,
    decision_valid: false,
    status: "ready",
    variance_techniques: varianceTechniques,
    ...overrides,
  };
}

export function resultKey(result: Pick<ArmResult, "metric_id" | "variant">): string {
  return `${result.metric_id}/${result.variant}`;
}

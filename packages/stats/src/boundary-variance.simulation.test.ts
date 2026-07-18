import type { DedupeExposureRow, PerEntityMetricRow } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { estimateMetricComparison } from "./variance-estimators";

const RUN_ID = "run_boundary_variance_simulation";
const METRIC_ID = "boundary_conversion";

describe("Binomial boundary variance simulation", () => {
  it("keeps opposing all-event arms from collapsing to a zero decision variance", () => {
    for (const sampleSize of [2, 10, 100]) {
      const result = opposingBoundaryComparison(sampleSize);

      expect(result.absolute_lift).toBe(-1);
      expect(result.absolute_lift_sampling_var).toBeGreaterThan(0);
    }
  });
});

function opposingBoundaryComparison(sampleSize: number) {
  const controlIds = entityIds("control", sampleSize);
  const treatmentIds = entityIds("treatment", sampleSize);
  return estimateMetricComparison({
    run_id: RUN_ID,
    metric_id: METRIC_ID,
    metric_type: "binomial",
    control_variant: "control",
    treatment_variant: "treatment",
    exposures: [...exposures("control", controlIds), ...exposures("treatment", treatmentIds)],
    metric_values: controlIds.map(binomialRow),
  });
}

function entityIds(variant: string, sampleSize: number): string[] {
  return Array.from({ length: sampleSize }, (_, index) => `${variant}_${index}`);
}

function exposures(variant: string, ids: readonly string[]): DedupeExposureRow[] {
  return ids.map((targeting_key_hash) => ({
    app_id: "app_1",
    targeting_key_hash,
    environment_id: "env_1",
    id_type: "user",
    run_id: RUN_ID,
    variant,
    first_exposure_ts: "2026-07-01T00:00:00.000Z",
    window_anchor: "2026-07-01T00:00:00.000Z",
  }));
}

function binomialRow(targeting_key_hash: string): PerEntityMetricRow {
  return {
    targeting_key_hash,
    run_id: RUN_ID,
    metric_id: METRIC_ID,
    metric_type: "binomial",
    value: 1,
    in_window: true,
  };
}

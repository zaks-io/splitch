import type { DedupeExposureRow, PerEntityMetricRow } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { estimateMetricComparison } from "./variance-estimators";

const RUN_ID = "run_boundary_variance_simulation";
const METRIC_ID = "boundary_conversion";

// Agresti-Caffo at n = 10 for either boundary: one success and two trials are
// added, so the rate adjusts to 11/12 (from 100%) or 1/12 (from 0%) and the
// variance is p(1-p)/12 either way.
const AGRESTI_CAFFO_VAR_AT_N10 = ((11 / 12) * (1 / 12)) / 12;

describe("Binomial boundary variance simulation", () => {
  it("keeps opposing all-event arms from collapsing to a zero decision variance", () => {
    for (const sampleSize of [2, 10, 100]) {
      const result = comparison({ sampleSize, controlConversions: sampleSize });

      expect(result.absolute_lift).toBe(-1);
      expect(result.absolute_lift_sampling_var).toBeGreaterThan(0);
    }
  });

  it("substitutes for a Control on the boundary and leaves the interior Treatment alone", () => {
    const result = comparison({ sampleSize: 10, controlConversions: 10, treatmentConversions: 5 });

    expect(result.control.sampling_var).toBe(0);
    expect(result.absolute_lift_var_components?.control).toBeCloseTo(AGRESTI_CAFFO_VAR_AT_N10, 12);
    expect(result.absolute_lift_var_components?.treatment).toBe(result.treatment.sampling_var);
    expect(result.absolute_lift_sampling_var).toBeCloseTo(
      AGRESTI_CAFFO_VAR_AT_N10 + (result.treatment.sampling_var ?? 0),
      12,
    );
  });

  it("substitutes for a Treatment on the boundary and leaves the interior Control alone", () => {
    const result = comparison({ sampleSize: 10, controlConversions: 5, treatmentConversions: 0 });

    expect(result.treatment.sampling_var).toBe(0);
    expect(result.absolute_lift_var_components?.treatment).toBeCloseTo(
      AGRESTI_CAFFO_VAR_AT_N10,
      12,
    );
    expect(result.absolute_lift_var_components?.control).toBe(result.control.sampling_var);
    expect(result.absolute_lift_sampling_var).toBeCloseTo(
      AGRESTI_CAFFO_VAR_AT_N10 + (result.control.sampling_var ?? 0),
      12,
    );
  });
});

function comparison({
  sampleSize,
  controlConversions = 0,
  treatmentConversions = 0,
}: {
  sampleSize: number;
  controlConversions?: number;
  treatmentConversions?: number;
}) {
  const controlIds = entityIds("control", sampleSize);
  const treatmentIds = entityIds("treatment", sampleSize);
  return estimateMetricComparison({
    run_id: RUN_ID,
    metric_id: METRIC_ID,
    metric_type: "binomial",
    control_variant: "control",
    treatment_variant: "treatment",
    exposures: [...exposures("control", controlIds), ...exposures("treatment", treatmentIds)],
    metric_values: [
      ...controlIds.slice(0, controlConversions).map(binomialRow),
      ...treatmentIds.slice(0, treatmentConversions).map(binomialRow),
    ],
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

import {
  HealthMetricsSchema,
  SrmResultSchema,
  type ActivationRow,
  type DedupeExposureRow,
} from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { checkSrmHealth } from "./srm-checker.js";
import { estimateMetricArm } from "./variance-estimators.js";

const RUN_ID = "run_srm_unit";
const BASE_TS = "2026-07-01T00:00:00.000Z";
const ACTIVATION_TS = "2026-07-01T00:05:00.000Z";

describe("SRMChecker", () => {
  it("returns null activated SRM and activation health when no Activation gate exists", () => {
    const result = checkSrmHealth({
      run_id: RUN_ID,
      allocation: { control: 50, treatment: 50 },
      exposures: [...exposures("control", 120), ...exposures("treatment", 120)],
    });

    expect(result.srm.activated_srm_p_value).toBeNull();
    expect(result.srm.activated_srm_mismatch).toBeNull();
    expect(result.health.activation_rates).toBeNull();
    expect(result.health.activation_balance_p_value).toBeNull();
    expect(result.health.activation_balance_mismatch).toBeNull();
  });

  it("emits the strict S61 SRM and HealthMetrics contracts without chi2_stat", () => {
    const result = checkSrmHealth({
      run_id: RUN_ID,
      allocation: { control: 50, treatment: 50 },
      exposures: [...exposures("control", 120), ...exposures("treatment", 120)],
    });

    expect(SrmResultSchema.parse(result.srm).srm_is_mismatch).toBe(false);
    expect(HealthMetricsSchema.parse(result.health).low_n_warning).toBe(false);
    expect("chi2_stat" in result.srm).toBe(false);
    expect(SrmResultSchema.safeParse({ ...result.srm, chi2_stat: 0 }).success).toBe(false);
    for (const field of ["multiple_count", "deduped_counts", "low_n_warning"]) {
      expect(HealthMetricsSchema.safeParse(omitField(result.health, field)).success).toBe(false);
    }
  });

  it("excludes multiple Entities from arm denominators and reports them separately", () => {
    const result = checkSrmHealth({
      run_id: RUN_ID,
      allocation: { control: 50, treatment: 50 },
      exposures: [
        ...exposures("control", 100),
        ...exposures("treatment", 100),
        ...exposures("__multiple__", 150),
      ],
    });

    expect(result.srm.observed_counts).toEqual({ control: 100, treatment: 100 });
    expect(result.health.deduped_counts).toEqual({ control: 100, treatment: 100 });
    expect(result.health.multiple_count).toBe(150);
    expect(result.health.multiple_rate).toBeCloseTo(150 / 350, 15);
    expect(result.srm.srm_is_mismatch).toBe(false);
  });

  it("uses the same deduped denominator as the variance path", () => {
    const duplicateRows = [
      exposure("control", "control_1"),
      exposure("control", "control_1"),
      exposure("control", "control_2"),
      exposure("treatment", "treatment_1"),
      exposure("treatment", "treatment_2"),
    ];
    const srm = checkSrmHealth({
      run_id: RUN_ID,
      allocation: { control: 50, treatment: 50 },
      exposures: duplicateRows,
    });
    const variance = estimateMetricArm({
      run_id: RUN_ID,
      metric_id: "conversion",
      metric_type: "binomial",
      variant: "control",
      exposures: duplicateRows,
      metric_values: [],
    });

    expect(srm.health.exposure_counts).toEqual({ control: 3, treatment: 2 });
    expect(srm.health.deduped_counts.control).toBe(variance.sample_size_n);
    expect(srm.health.deduped_counts).toEqual({ control: 2, treatment: 2 });
  });

  it("flags activation balance when Treatment changes Activation rate", () => {
    const control = exposures("control", 500);
    const treatment = exposures("treatment", 500);
    const result = checkSrmHealth({
      run_id: RUN_ID,
      allocation: { control: 50, treatment: 50 },
      exposures: [...control, ...treatment],
      activation_rows: [
        ...activationRows(control.slice(0, 100)),
        ...activationRows(treatment.slice(0, 300)),
      ],
    });

    expect(result.srm.srm_is_mismatch).toBe(false);
    expect(result.srm.activated_srm_mismatch).toBe(true);
    expect(result.health.activation_rates).toEqual({ control: 0.2, treatment: 0.6 });
    expect(result.health.activation_balance_mismatch).toBe(true);
    expect(result.health.activation_balance_p_value).toBeLessThan(0.001);
  });
});

function omitField(input: Record<string, unknown>, field: string): Record<string, unknown> {
  const copy = { ...input };
  delete copy[field];
  return copy;
}

function exposures(variant: string, count: number): DedupeExposureRow[] {
  return Array.from({ length: count }, (_, index) => exposure(variant, `${variant}_${index}`));
}

function exposure(variant: string, targeting_key_hash: string): DedupeExposureRow {
  return {
    app_id: "app_1",
    targeting_key_hash,
    environment_id: "env_1",
    id_type: "user",
    run_id: RUN_ID,
    variant,
    first_exposure_ts: BASE_TS,
    window_anchor: BASE_TS,
  };
}

function activationRows(exposureRows: readonly DedupeExposureRow[]): ActivationRow[] {
  return exposureRows.map((row) => ({
    targeting_key_hash: row.targeting_key_hash,
    run_id: RUN_ID,
    activation_ts: ACTIVATION_TS,
    counterfactual: false,
    activated: true,
  }));
}

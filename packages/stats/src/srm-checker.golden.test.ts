import type { ActivationRow, DedupeExposureRow } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { checkSrmHealth } from "./srm-checker";

const RUN_ID = "run_srm_golden";
const BASE_TS = "2026-07-01T00:00:00.000Z";
const ACTIVATION_TS = "2026-07-01T00:05:00.000Z";

describe("SRMChecker golden fixtures", () => {
  it("trips full-exposed SRM when observed counts drift from allocation", () => {
    const result = checkSrmHealth({
      run_id: RUN_ID,
      allocation: { control: 50, treatment: 50 },
      exposures: [...exposures("control", 900), ...exposures("treatment", 100)],
    });

    expect(result.srm.observed_counts).toEqual({ control: 900, treatment: 100 });
    expect(result.srm.expected_counts).toEqual({ control: 500, treatment: 500 });
    expect(result.srm.srm_p_value).toBeLessThan(0.001);
    expect(result.srm.srm_is_mismatch).toBe(true);
  });

  it("trips activated SRM and activation balance while full-exposed SRM is clean", () => {
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
    expect(result.srm.activated_srm_p_value).toBeLessThan(0.001);
    expect(result.srm.activated_srm_mismatch).toBe(true);
    expect(result.health.activation_rates).toEqual({ control: 0.2, treatment: 0.6 });
    expect(result.health.activation_balance_p_value).toBeLessThan(0.001);
    expect(result.health.activation_balance_mismatch).toBe(true);
  });

  it("keeps activated SRM null when no Activation gate exists", () => {
    const result = checkSrmHealth({
      run_id: RUN_ID,
      allocation: { control: 50, treatment: 50 },
      exposures: [...exposures("control", 500), ...exposures("treatment", 500)],
    });

    expect(result.srm.activated_srm_p_value).toBeNull();
    expect(result.srm.activated_srm_mismatch).toBeNull();
    expect(result.health.activation_rates).toBeNull();
  });

  it("excludes multiple from SRM denominators and reports multiple_count", () => {
    const result = checkSrmHealth({
      run_id: RUN_ID,
      allocation: { control: 50, treatment: 50 },
      exposures: [
        ...exposures("control", 500),
        ...exposures("treatment", 500),
        ...exposures("__multiple__", 10),
      ],
    });

    expect(result.srm.observed_counts).toEqual({ control: 500, treatment: 500 });
    expect(result.health.deduped_counts).toEqual({ control: 500, treatment: 500 });
    expect(result.health.multiple_count).toBe(10);
    expect(result.health.multiple_rate).toBeCloseTo(10 / 1010, 15);
    expect(result.srm.srm_is_mismatch).toBe(false);
  });

  it("populates deduped_counts and low_n_warning from the SRM input", () => {
    const result = checkSrmHealth({
      run_id: RUN_ID,
      allocation: { control: 50, treatment: 50 },
      exposures: [...exposures("control", 99), ...exposures("treatment", 101)],
    });

    expect(result.health.deduped_counts).toEqual({ control: 99, treatment: 101 });
    expect(result.srm.observed_counts).toEqual(result.health.deduped_counts);
    expect(result.health.low_n_warning).toBe(true);
  });
});

function exposures(variant: string, count: number): DedupeExposureRow[] {
  return Array.from({ length: count }, (_, index) => ({
    app_id: "app_1",
    targeting_key_hash: `${variant}_${index}`,
    environment_id: "env_1",
    id_type: "user",
    run_id: RUN_ID,
    variant,
    first_exposure_ts: BASE_TS,
    window_anchor: BASE_TS,
  }));
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

import { describe, expect, it } from "vitest";
import { checkSrmHealth } from "./srm-checker";
import {
  activationRowsAt,
  exposureOnDay,
  exposures,
  exposuresOnDay,
  SRM_TEST_RUN_ID,
} from "./srm-checker-test-helpers";

const RUN_ID = SRM_TEST_RUN_ID;

describe("SRMChecker sequential Exposure path", () => {
  it("uses sequential anytime p-values when srm_procedure is sequential_martingale", () => {
    const shared = {
      run_id: RUN_ID,
      allocation: { control: 50, treatment: 50 },
      exposures: [...exposures("control", 900), ...exposures("treatment", 100)],
    };
    const chiSquare = checkSrmHealth(shared);
    const explicitChiSquare = checkSrmHealth({ ...shared, srm_procedure: "chi_square" });
    const sequential = checkSrmHealth({ ...shared, srm_procedure: "sequential_martingale" });

    expect(explicitChiSquare).toEqual(chiSquare);
    expect(chiSquare.srm.srm_is_mismatch).toBe(true);
    expect(sequential.srm.srm_is_mismatch).toBe(true);
    expect(sequential.srm.srm_p_value).not.toBe(chiSquare.srm.srm_p_value);
    expect(sequential.srm.observed_counts).toEqual(chiSquare.srm.observed_counts);
  });

  it("keeps the Exposure SRM alarm when same-day later arrivals balance totals", () => {
    const early = "2026-07-01T08:00:00.000Z";
    const late = "2026-07-01T18:00:00.000Z";
    const earlyOnly = checkSrmHealth({
      run_id: RUN_ID,
      allocation: { control: 50, treatment: 50 },
      exposures: [
        ...exposuresOnDay("control", 900, early),
        ...exposuresOnDay("treatment", 100, early),
      ],
      srm_procedure: "sequential_martingale",
    });
    const afterBalance = checkSrmHealth({
      run_id: RUN_ID,
      allocation: { control: 50, treatment: 50 },
      exposures: [
        ...exposuresOnDay("control", 900, early),
        ...exposuresOnDay("treatment", 100, early),
        ...exposuresOnDay("treatment", 800, late, 100),
      ],
      srm_procedure: "sequential_martingale",
    });

    expect(earlyOnly.srm.srm_is_mismatch).toBe(true);
    expect(earlyOnly.srm.srm_p_value).toBeLessThan(1e-100);
    expect(afterBalance.srm.observed_counts).toEqual({ control: 900, treatment: 900 });
    expect(afterBalance.srm.srm_is_mismatch).toBe(true);
    expect(afterBalance.srm.srm_p_value).toBe(earlyOnly.srm.srm_p_value);
  });

  it("recomputes a sequential path after quarantine without throwing", () => {
    const dayOne = "2026-07-01T00:00:00.000Z";
    const dayTwo = "2026-07-02T00:00:00.000Z";
    // Interleave hashes so same-timestamp ties alternate arms (HMAC-like, not
    // variant-prefixed names that would sort all of one arm first).
    const dayOneExposures = Array.from({ length: 120 }, (_, index) => {
      const stem = index.toString(16).padStart(8, "0");
      return [
        exposureOnDay("control", `${stem}c`, dayOne),
        exposureOnDay("treatment", `${stem}t`, dayOne),
      ];
    }).flat();
    const before = checkSrmHealth({
      run_id: RUN_ID,
      allocation: { control: 50, treatment: 50 },
      exposures: [...dayOneExposures, exposureOnDay("control", "to_quarantine", dayTwo)],
      srm_procedure: "sequential_martingale",
    });
    const after = checkSrmHealth({
      run_id: RUN_ID,
      allocation: { control: 50, treatment: 50 },
      exposures: [...dayOneExposures, exposureOnDay("__multiple__", "to_quarantine", dayTwo)],
      srm_procedure: "sequential_martingale",
    });

    expect(before.srm.observed_counts).toEqual({ control: 121, treatment: 120 });
    expect(after.srm.observed_counts).toEqual({ control: 120, treatment: 120 });
    expect(after.health.multiple_count).toBe(1);
    expect(Number.isFinite(after.srm.srm_p_value)).toBe(true);
    expect(after.srm.srm_is_mismatch).toBe(false);
  });

  it("is deterministic for pinned watermarks including identical-timestamp ties", () => {
    const tiedTs = "2026-07-01T12:00:00.000Z";
    const pinnedExposures = [
      ...exposuresOnDay("control", 200, tiedTs),
      ...exposuresOnDay("treatment", 50, tiedTs),
      ...exposuresOnDay("treatment", 150, "2026-07-01T18:00:00.000Z", 50),
    ];
    const input = {
      run_id: RUN_ID,
      allocation: { control: 50, treatment: 50 },
      exposures: pinnedExposures,
      srm_procedure: "sequential_martingale" as const,
    };
    const first = checkSrmHealth(input);
    const second = checkSrmHealth({ ...input, exposures: [...pinnedExposures].reverse() });

    expect(second.srm).toEqual(first.srm);
    expect(second.health).toEqual(first.health);
  });
});

describe("SRMChecker sequential activated path", () => {
  it("keeps activated SRM alarm when same-day later activations balance totals", () => {
    const exposureTs = "2026-07-01T00:00:00.000Z";
    const earlyActivation = "2026-07-01T08:00:00.000Z";
    const lateActivation = "2026-07-01T18:00:00.000Z";
    const control = exposuresOnDay("control", 900, exposureTs);
    const treatmentEarly = exposuresOnDay("treatment", 100, exposureTs);
    const treatmentLate = exposuresOnDay("treatment", 800, exposureTs, 100);
    const earlyOnly = checkSrmHealth({
      run_id: RUN_ID,
      allocation: { control: 50, treatment: 50 },
      exposures: [...control, ...treatmentEarly],
      activation_rows: [
        ...activationRowsAt(control, earlyActivation),
        ...activationRowsAt(treatmentEarly, earlyActivation),
      ],
      srm_procedure: "sequential_martingale",
    });
    const afterBalance = checkSrmHealth({
      run_id: RUN_ID,
      allocation: { control: 50, treatment: 50 },
      exposures: [...control, ...treatmentEarly, ...treatmentLate],
      activation_rows: [
        ...activationRowsAt(control, earlyActivation),
        ...activationRowsAt(treatmentEarly, earlyActivation),
        ...activationRowsAt(treatmentLate, lateActivation),
      ],
      srm_procedure: "sequential_martingale",
    });

    expect(earlyOnly.srm.activated_srm_mismatch).toBe(true);
    expect(earlyOnly.srm.activated_srm_p_value).toBeLessThan(1e-100);
    expect(afterBalance.srm.activated_srm_mismatch).toBe(true);
    expect(afterBalance.srm.activated_srm_p_value).toBe(earlyOnly.srm.activated_srm_p_value);
  });

  it("orders activated sequential SRM by activation_ts rather than first Exposure", () => {
    const dayOne = "2026-07-01T00:00:00.000Z";
    const dayTwo = "2026-07-02T00:00:00.000Z";
    const control = exposuresOnDay("control", 900, dayOne);
    const treatmentEarlyExposure = exposuresOnDay("treatment", 100, dayOne);
    const treatmentLateExposure = exposuresOnDay("treatment", 800, dayTwo, 100);
    // Activations arrive in reverse Exposure-day order: day-two Entities first.
    const result = checkSrmHealth({
      run_id: RUN_ID,
      allocation: { control: 50, treatment: 50 },
      exposures: [...control, ...treatmentEarlyExposure, ...treatmentLateExposure],
      activation_rows: [
        ...activationRowsAt(treatmentLateExposure, "2026-07-03T08:00:00.000Z"),
        ...activationRowsAt(control, "2026-07-03T18:00:00.000Z"),
        ...activationRowsAt(treatmentEarlyExposure, "2026-07-03T18:00:00.000Z"),
      ],
      srm_procedure: "sequential_martingale",
    });

    // Prefix is 800 treatment then later 900/100 control/treatment; alarm from
    // the reverse-order activation prefix must stick.
    expect(result.srm.activated_srm_mismatch).toBe(true);
    expect(result.srm.activated_srm_p_value).toBeLessThan(1e-100);
  });
});

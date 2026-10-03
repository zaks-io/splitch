import { describe, expect, it } from "vitest";
import { checkSrmHealth } from "./srm-checker";
import {
  activationRows,
  exposureOnDay,
  exposures,
  exposuresOnDay,
  SRM_TEST_RUN_ID,
} from "./srm-checker-test-helpers";

const RUN_ID = SRM_TEST_RUN_ID;

describe("SRMChecker sequential martingale path", () => {
  it("uses sequential anytime p-values when srm_procedure is sequential_martingale", () => {
    const shared = {
      run_id: RUN_ID,
      allocation: { control: 50, treatment: 50 },
      exposures: [...exposures("control", 900), ...exposures("treatment", 100)],
    };
    const chiSquare = checkSrmHealth(shared);
    const sequential = checkSrmHealth({ ...shared, srm_procedure: "sequential_martingale" });

    expect(chiSquare.srm.srm_is_mismatch).toBe(true);
    expect(sequential.srm.srm_is_mismatch).toBe(true);
    expect(sequential.srm.srm_p_value).not.toBe(chiSquare.srm.srm_p_value);
    expect(sequential.srm.observed_counts).toEqual(chiSquare.srm.observed_counts);
  });

  it("keeps the sequential SRM alarm along a 900/100 then 900/900 first-Exposure path", () => {
    const dayOne = "2026-07-01T00:00:00.000Z";
    const dayTwo = "2026-07-02T00:00:00.000Z";
    const pathExposures = [
      ...exposuresOnDay("control", 900, dayOne),
      ...exposuresOnDay("treatment", 100, dayOne),
      ...exposuresOnDay("treatment", 800, dayTwo, 100),
    ];
    const result = checkSrmHealth({
      run_id: RUN_ID,
      allocation: { control: 50, treatment: 50 },
      exposures: pathExposures,
      srm_procedure: "sequential_martingale",
    });

    expect(result.srm.observed_counts).toEqual({ control: 900, treatment: 900 });
    expect(result.srm.srm_is_mismatch).toBe(true);
    expect(result.srm.srm_p_value).toBeLessThan(1e-100);
  });

  it("recomputes a monotone sequential path after quarantine without throwing", () => {
    const dayOne = "2026-07-01T00:00:00.000Z";
    const dayTwo = "2026-07-02T00:00:00.000Z";
    const before = checkSrmHealth({
      run_id: RUN_ID,
      allocation: { control: 50, treatment: 50 },
      exposures: [
        ...exposuresOnDay("control", 120, dayOne),
        ...exposuresOnDay("treatment", 120, dayOne),
        exposureOnDay("control", "to_quarantine", dayTwo),
      ],
      srm_procedure: "sequential_martingale",
    });
    const after = checkSrmHealth({
      run_id: RUN_ID,
      allocation: { control: 50, treatment: 50 },
      exposures: [
        ...exposuresOnDay("control", 120, dayOne),
        ...exposuresOnDay("treatment", 120, dayOne),
        exposureOnDay("__multiple__", "to_quarantine", dayTwo),
      ],
      srm_procedure: "sequential_martingale",
    });

    expect(before.srm.observed_counts).toEqual({ control: 121, treatment: 120 });
    expect(after.srm.observed_counts).toEqual({ control: 120, treatment: 120 });
    expect(after.health.multiple_count).toBe(1);
    expect(after.srm.srm_is_mismatch).toBe(false);
    expect(Number.isFinite(after.srm.srm_p_value)).toBe(true);
  });

  it("is deterministic for the same pinned-watermark sequential Entity set", () => {
    const pinnedExposures = [
      ...exposuresOnDay("control", 200, "2026-07-01T00:00:00.000Z"),
      ...exposuresOnDay("treatment", 50, "2026-07-01T00:00:00.000Z"),
      ...exposuresOnDay("treatment", 150, "2026-07-02T00:00:00.000Z", 50),
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

  it("keeps activated sequential SRM sticky along the first-Exposure day path", () => {
    const dayOne = "2026-07-01T00:00:00.000Z";
    const dayTwo = "2026-07-02T00:00:00.000Z";
    const control = exposuresOnDay("control", 900, dayOne);
    const treatmentDayOne = exposuresOnDay("treatment", 100, dayOne);
    const treatmentDayTwo = exposuresOnDay("treatment", 800, dayTwo, 100);
    const result = checkSrmHealth({
      run_id: RUN_ID,
      allocation: { control: 50, treatment: 50 },
      exposures: [...control, ...treatmentDayOne, ...treatmentDayTwo],
      activation_rows: activationRows([...control, ...treatmentDayOne, ...treatmentDayTwo]),
      srm_procedure: "sequential_martingale",
    });

    expect(result.srm.activated_srm_mismatch).toBe(true);
    expect(result.srm.activated_srm_p_value).toBeLessThan(1e-100);
  });
});

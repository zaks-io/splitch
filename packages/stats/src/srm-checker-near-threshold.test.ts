import { describe, expect, it } from "vitest";
import { checkSrmHealth } from "./srm-checker";
import { exposuresOnDayWithIngest, SRM_TEST_RUN_ID } from "./srm-checker-test-helpers";

const RUN_ID = SRM_TEST_RUN_ID;

describe("near-threshold sequential Exposure SRM (45/45)", () => {
  it("crosses at p≈0.000946 then a quarantined early Control lifts live p≈0.001234", () => {
    const early = "2026-07-01T00:00:00.000Z";
    const late = "2026-07-02T00:00:00.000Z";
    const crossed = checkSrmHealth({
      run_id: RUN_ID,
      allocation: { control: 50, treatment: 50 },
      exposures: [
        ...exposuresOnDayWithIngest("control", 45, early, early),
        ...exposuresOnDayWithIngest("treatment", 45, late, late),
      ],
      srm_procedure: "sequential_martingale",
    });
    const quarantinedControl = exposuresOnDayWithIngest("control", 1, early, early, 44).map(
      (row) => ({ ...row, variant: "__multiple__" }),
    );
    const afterQuarantine = checkSrmHealth({
      run_id: RUN_ID,
      allocation: { control: 50, treatment: 50 },
      exposures: [
        ...exposuresOnDayWithIngest("control", 44, early, early),
        ...quarantinedControl,
        ...exposuresOnDayWithIngest("treatment", 45, late, late),
      ],
      srm_procedure: "sequential_martingale",
    });

    expect(crossed.srm.srm_is_mismatch).toBe(true);
    expect(crossed.srm.srm_p_value).toBeCloseTo(0.0009455654, 6);
    expect(afterQuarantine.srm.observed_counts).toEqual({ control: 44, treatment: 45 });
    expect(afterQuarantine.srm.srm_is_mismatch).toBe(false);
    expect(afterQuarantine.srm.srm_p_value).toBeCloseTo(0.0012344882, 6);
  });
});

import { describe, expect, it } from "vitest";
import { adjustCupedArms } from "./cuped-fit";
import type { EntityAggregate } from "./variance-estimator-types";

/**
 * The A/A Type-I simulation is what proves the shared fit is unbiased, but it
 * runs thousands of trials and is excluded from the mutation config, so the
 * structural claims it rests on are pinned directly here: one slope and one
 * centering constant across both arms, an uncorrelated covariate leaving the
 * lift alone, and every degenerate covariate shape resolving to a number rather
 * than a NaN.
 */

describe("adjustCupedArms", () => {
  it("centers both arms on the pooled covariate mean, not each arm's own", () => {
    // Control covariates average 1, Treatment's average 3, pooled mean is 2. A
    // per-arm fit would subtract each arm's own mean and cancel the imbalance;
    // the shared fit has to leave it visible in the adjusted difference.
    const control = arm("c", [10, 12, 14]);
    const treatment = arm("t", [20, 22, 24]);
    const covariates = new Map([
      ["c0", 0],
      ["c1", 1],
      ["c2", 2],
      ["t0", 2],
      ["t1", 3],
      ["t2", 4],
    ]);

    const adjusted = adjustCupedArms(control, covariates, treatment, covariates);

    // theta is 2 here (y moves 2 per unit of x within each arm), so each entity
    // shifts by -2 * (x - 2).
    expect(adjusted.control.map((entity) => entity.value)).toEqual([14, 14, 14]);
    expect(adjusted.treatment.map((entity) => entity.value)).toEqual([20, 20, 20]);
  });

  it("marks only the entities that carried a covariate", () => {
    const control = arm("c", [10, 12, 14]);
    const treatment = arm("t", [20, 22, 24]);
    const covariates = new Map([
      ["c0", 0],
      ["c1", 1],
      ["t0", 2],
      ["t1", 3],
    ]);

    const adjusted = adjustCupedArms(control, covariates, treatment, covariates);

    expect(adjusted.control.map((entity) => entity.cuped_adjusted)).toEqual([true, true, false]);
    expect(adjusted.treatment.map((entity) => entity.cuped_adjusted)).toEqual([true, true, false]);
    // Two covered entities per arm are enough to fit a slope: theta is 2 and
    // the pooled covariate mean is 1.5.
    expect(adjusted.control.map((entity) => entity.value)).toEqual([13, 13, 14]);
    expect(adjusted.treatment.map((entity) => entity.value)).toEqual([19, 19, 24]);
  });

  it("returns unadjusted copies when no entity has a covariate", () => {
    const control = arm("c", [10, 12]);
    const treatment = arm("t", [20, 22]);
    const empty = new Map<string, number>();

    const adjusted = adjustCupedArms(control, empty, treatment, empty);

    expect(adjusted.control.map((entity) => entity.value)).toEqual([10, 12]);
    expect(adjusted.control.every((entity) => entity.cuped_adjusted)).toBe(false);
    expect(adjusted.control[0]).not.toBe(control[0]);
  });

  it("falls back to a zero slope when the covariate never varies", () => {
    // Every x identical drives the sum of squares to zero. Dividing by it would
    // hand every entity a NaN value, which is a silently wrong Run rather than
    // a loud one.
    const control = arm("c", [10, 12, 14]);
    const treatment = arm("t", [20, 22, 24]);
    const covariates = new Map([
      ["c0", 5],
      ["c1", 5],
      ["c2", 5],
      ["t0", 5],
      ["t1", 5],
      ["t2", 5],
    ]);

    const adjusted = adjustCupedArms(control, covariates, treatment, covariates);

    expect(adjusted.control.map((entity) => entity.value)).toEqual([10, 12, 14]);
    expect(adjusted.treatment.map((entity) => entity.value)).toEqual([20, 22, 24]);
  });

  it("ignores an arm that cannot produce a within-arm slope", () => {
    // One covered entity has no within-arm variation to contribute, so the
    // slope comes from the other arm alone while the pooled centering constant
    // still counts it.
    const control = arm("c", [10]);
    const treatment = arm("t", [20, 24, 28]);
    const covariates = new Map([
      ["c0", 6],
      ["t0", 0],
      ["t1", 2],
      ["t2", 4],
    ]);

    const adjusted = adjustCupedArms(control, covariates, treatment, covariates);

    // theta is 2 from the Treatment arm; xBar is the pooled mean, 3.
    expect(adjusted.control[0]?.value).toBe(10 - 2 * (6 - 3));
    expect(adjusted.treatment.map((entity) => entity.value)).toEqual([26, 26, 26]);
  });
});

function arm(prefix: string, values: readonly number[]): EntityAggregate[] {
  return values.map((value, index) => ({
    targeting_key_hash: `${prefix}${index}`,
    first_exposure_ts: "2026-01-01T00:00:00Z",
    window_anchor: "2026-01-01T00:00:00Z",
    value,
    num_value: value,
    denom_value: 1,
    cuped_adjusted: false,
  }));
}

import { describe, expect, it } from "vitest";
import {
  normalMixtureOneSidedBoundary,
  normalMixtureOneSidedScale,
  rhoSquaredForOneSidedTargetN,
} from "./normal-mixture-one-sided";
import { normalMixtureScale, rhoSquaredForTargetN } from "./sequential-ci";

const GOLDEN_TOLERANCE = 1e-12;

describe("Proposition B.1 one-sided normal-mixture golden fixtures", () => {
  it("matches the Proposition B.1 formula on a reference tuple", () => {
    const n = 5_000;
    const alpha = 0.05;
    const targetN = 5_000;
    const standardError = 0.02;
    const rhoSquared = rhoSquaredForOneSidedTargetN(alpha, targetN);
    const informationRatio = n * rhoSquared;
    const expectedScale = Math.sqrt(
      (2 * (1 + informationRatio) * Math.log(1 + Math.sqrt(1 + informationRatio) / (2 * alpha))) /
        informationRatio,
    );
    const expectedBoundary = standardError * expectedScale;

    expect(rhoSquared).toBeCloseTo(0.0013276704135987624, 15);
    expect(normalMixtureOneSidedScale(n, alpha, rhoSquared)).toBeCloseTo(expectedScale, 15);
    expect(normalMixtureOneSidedBoundary(standardError, n, alpha, targetN)).toBeCloseTo(
      expectedBoundary,
      15,
    );
    expect(Math.abs(expectedScale - 2.7785153234980133)).toBeLessThanOrEqual(GOLDEN_TOLERANCE);
    expect(Math.abs(expectedBoundary - 0.055570306469960265)).toBeLessThanOrEqual(GOLDEN_TOLERANCE);
  });

  it("is not the two-sided bound at doubled alpha", () => {
    // The additive 1 inside Prop B.1's log is the whole point of C4's correction.
    const n = 5_000;
    const alpha = 0.05;
    const targetN = 5_000;
    const oneSidedRho = rhoSquaredForOneSidedTargetN(alpha, targetN);
    const twoSidedAt2Alpha = normalMixtureScale(
      n,
      2 * alpha,
      rhoSquaredForTargetN(2 * alpha, targetN),
    );
    const oneSided = normalMixtureOneSidedScale(n, alpha, oneSidedRho);

    expect(oneSided).not.toBeCloseTo(twoSidedAt2Alpha, 6);
    expect(oneSided).toBeGreaterThan(twoSidedAt2Alpha);
  });
});

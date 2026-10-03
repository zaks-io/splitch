import { describe, expect, it } from "vitest";
import {
  normalMixtureOneSidedScale,
  rhoSquaredForOneSidedTargetN,
} from "./normal-mixture-one-sided";

describe("normalMixtureOneSidedScale", () => {
  it("fails loud on invalid alpha or n", () => {
    expect(() => normalMixtureOneSidedScale(0, 0.05, 0.001)).toThrow(/n must be finite/);
    expect(() => normalMixtureOneSidedScale(100, 0, 0.001)).toThrow(/alpha must be finite/);
    expect(() => rhoSquaredForOneSidedTargetN(0.5, 1_000)).toThrow(/one-sided alpha/);
  });

  it("tightens as alpha grows", () => {
    const rho = rhoSquaredForOneSidedTargetN(0.05, 5_000);
    expect(normalMixtureOneSidedScale(5_000, 0.01, rho)).toBeGreaterThan(
      normalMixtureOneSidedScale(5_000, 0.05, rho),
    );
  });
});

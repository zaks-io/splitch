import { describe, expect, it } from "vitest";
import { chiSquareUpperTail } from "../src/chi-square";
import { inverseNormalCdf, normalCdf, normalSurvival } from "../src/normal-distribution";
import { fixedHorizonPValue } from "../src/fixed-horizon-ci";

/**
 * Independent audit: check the primitives against values that do not come from
 * this codebase. Every expected number below is a published/derivable constant.
 */

describe("normalCdf against known quantiles", () => {
  const cases: Array<[number, number]> = [
    [0, 0.5],
    [1, 0.8413447460685429],
    [-1, 0.15865525393145705],
    [1.959963984540054, 0.975],
    [-1.959963984540054, 0.025],
    [2.5758293035489004, 0.995],
    [3, 0.9986501019683699],
    [-3, 0.0013498980316300933],
    [5, 0.9999997133484281],
  ];

  for (const [x, expected] of cases) {
    it(`Phi(${x})`, () => {
      const actual = normalCdf(x);
      expect(Math.abs(actual - expected)).toBeLessThan(2e-7);
    });
  }
});

describe("normalSurvival against known tails", () => {
  // 1 - Phi(x) to full double precision.
  const cases: Array<[number, number]> = [
    [1, 0.15865525393145705],
    [1.959963984540054, 0.025],
    [3, 0.0013498980316300933],
    [4, 3.167124183311998e-5],
    [5, 2.866515718791939e-7],
    [6, 9.865876450376946e-10],
    [8, 6.220960574271786e-16],
  ];

  for (const [x, expected] of cases) {
    it(`1-Phi(${x}) relative accuracy`, () => {
      const actual = normalSurvival(x);
      expect(Math.abs(actual - expected) / expected).toBeLessThan(2e-7);
    });
  }
});

describe("inverseNormalCdf against known quantiles", () => {
  const cases: Array<[number, number]> = [
    [0.5, 0],
    [0.975, 1.959963984540054],
    [0.995, 2.5758293035489004],
    [0.9995, 3.2905267314918945],
    [0.025, -1.959963984540054],
    [0.0005, -3.2905267314918945],
    [0.9, 1.2815515655446004],
    [1e-10, -6.361340902404056],
  ];

  for (const [p, expected] of cases) {
    it(`Phi^-1(${p})`, () => {
      const actual = inverseNormalCdf(p);
      expect(Math.abs(actual - expected)).toBeLessThan(1e-6);
    });
  }

  it("round-trips against normalCdf across the body", () => {
    for (let p = 0.001; p < 0.999; p += 0.001) {
      const z = inverseNormalCdf(p);
      expect(Math.abs(normalCdf(z) - p)).toBeLessThan(1e-6);
    }
  });
});

describe("chiSquareUpperTail against closed forms", () => {
  // df = 2 has the exact closed form Q = exp(-x/2).
  for (const x of [0.5, 1, 2, 5, 10, 20, 40, 80]) {
    it(`df=2 x=${x} equals exp(-x/2)`, () => {
      const expected = Math.exp(-x / 2);
      const actual = chiSquareUpperTail(x, 2);
      expect(Math.abs(actual - expected) / expected).toBeLessThan(1e-10);
    });
  }

  // df = 1 has the exact closed form Q = 2 * (1 - Phi(sqrt(x))).
  for (const x of [0.5, 1, 3.841458820694124, 10.827566170662733, 25]) {
    it(`df=1 x=${x} equals 2*(1-Phi(sqrt(x)))`, () => {
      const expected = 2 * normalSurvival(Math.sqrt(x));
      const actual = chiSquareUpperTail(x, 1);
      expect(Math.abs(actual - expected) / expected).toBeLessThan(1e-6);
    });
  }

  it("hits the published 5% critical values", () => {
    expect(chiSquareUpperTail(3.841458820694124, 1)).toBeCloseTo(0.05, 8);
    expect(chiSquareUpperTail(5.991464547107979, 2)).toBeCloseTo(0.05, 8);
    expect(chiSquareUpperTail(7.814727903251179, 3)).toBeCloseTo(0.05, 8);
    expect(chiSquareUpperTail(9.487729036781154, 4)).toBeCloseTo(0.05, 8);
  });

  it("hits the published 0.1% SRM critical value", () => {
    expect(chiSquareUpperTail(10.827566170662733, 1)).toBeCloseTo(0.001, 9);
    expect(chiSquareUpperTail(13.815510557964274, 2)).toBeCloseTo(0.001, 9);
  });
});

describe("fixedHorizonPValue tail accuracy", () => {
  const cases: Array<[number, number]> = [
    [1.959963984540054, 0.05],
    [2.5758293035489004, 0.01],
    [3.2905267314918945, 0.001],
    [4, 6.334248366623996e-5],
    [4.5, 6.79534960143286e-6],
    [5, 5.733031437583878e-7],
    [5.5, 3.797912493177544e-8],
    [6, 1.9731752900753892e-9],
  ];

  for (const [z, expected] of cases) {
    it(`two-sided p at z=${z} is accurate to 1%`, () => {
      const actual = fixedHorizonPValue(z, 1);
      expect(Math.abs(actual - expected) / expected).toBeLessThan(0.01);
    });
  }
});

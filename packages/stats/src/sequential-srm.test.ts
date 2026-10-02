import { describe, expect, it } from "vitest";
import {
  computeSequentialSrm,
  SEQUENTIAL_SRM_DEFAULT_ALPHA,
  SEQUENTIAL_SRM_SOURCE,
} from "./sequential-srm";

const EQUAL_ALLOCATION = { control: 50, treatment: 50 };

describe("computeSequentialSrm", () => {
  it("identifies the Lindon-Malek Dirichlet-multinomial mixture", () => {
    expect(SEQUENTIAL_SRM_SOURCE.family).toBe("dirichlet-multinomial-mixture-martingale");
    expect(SEQUENTIAL_SRM_SOURCE.references[0]).toContain("12f3bd5d2b7d93eadc1bf508a0872dc2");
  });

  it("starts at unit wealth with no observations", () => {
    const result = computeSequentialSrm({
      allocation: EQUAL_ALLOCATION,
      observations: { mode: "increments", batches: [] },
    });

    expect(result).toMatchObject({
      wealth: 1,
      anytime_p_value: 1,
      threshold_crossed: false,
      first_cross_n: null,
      total_n: 0,
      counts: { control: 0, treatment: 0 },
    });
    expect(SEQUENTIAL_SRM_DEFAULT_ALPHA).toBe(0.001);
  });

  it("matches the two-step conjugate Bayes factor on a golden pair", () => {
    const result = computeSequentialSrm({
      allocation: EQUAL_ALLOCATION,
      observations: {
        mode: "increments",
        batches: [{ treatment: 1 }, { treatment: 1 }],
      },
      concentration: 100,
    });

    expect(result.wealth).toBeCloseTo(102 / 101, 12);
    expect(result.anytime_p_value).toBeCloseTo(101 / 102, 12);
    expect(result.total_n).toBe(2);
    expect(result.counts).toEqual({ control: 0, treatment: 2 });
  });

  it("treats append-only cumulative snapshots as the same increment path", () => {
    const increments = computeSequentialSrm({
      allocation: EQUAL_ALLOCATION,
      observations: {
        mode: "increments",
        batches: [{ control: 2, treatment: 1 }, { treatment: 3 }],
      },
    });
    const cumulative = computeSequentialSrm({
      allocation: EQUAL_ALLOCATION,
      observations: {
        mode: "cumulative",
        snapshots: [
          { control: 2, treatment: 1 },
          { control: 2, treatment: 4 },
        ],
      },
    });

    expect(cumulative.wealth).toBeCloseTo(increments.wealth, 12);
    expect(cumulative.anytime_p_value).toBeCloseTo(increments.anytime_p_value, 12);
    expect(cumulative.counts).toEqual(increments.counts);
  });

  it("keeps a fired alarm after later null-like counts reduce wealth", () => {
    const treatmentOnly = Array.from({ length: 120 }, () => ({ treatment: 1 }));
    const rebalance = Array.from({ length: 120 }, () => ({ control: 1 }));
    const crossed = computeSequentialSrm({
      allocation: EQUAL_ALLOCATION,
      observations: { mode: "increments", batches: treatmentOnly },
      alpha: 0.05,
    });
    const persisted = computeSequentialSrm({
      allocation: EQUAL_ALLOCATION,
      observations: { mode: "increments", batches: [...treatmentOnly, ...rebalance] },
      alpha: 0.05,
    });

    expect(crossed.threshold_crossed).toBe(true);
    expect(crossed.first_cross_n).toBeGreaterThan(0);
    expect(persisted.wealth).toBeLessThan(crossed.wealth);
    expect(persisted.threshold_crossed).toBe(true);
    expect(persisted.anytime_p_value).toBe(crossed.anytime_p_value);
    expect(persisted.first_cross_n).toBe(crossed.first_cross_n);
  });

  it("fails loud on invalid inputs and count revisions", () => {
    const cases: Array<{ label: string; input: Parameters<typeof computeSequentialSrm>[0] }> = [
      {
        label: "one variant",
        input: {
          allocation: { control: 100 },
          observations: { mode: "increments", batches: [] },
        },
      },
      {
        label: "non-positive allocation",
        input: {
          allocation: { control: 50, treatment: 0 },
          observations: { mode: "increments", batches: [] },
        },
      },
      {
        label: "alpha outside (0, 1)",
        input: {
          allocation: EQUAL_ALLOCATION,
          observations: { mode: "increments", batches: [] },
          alpha: 0,
        },
      },
      {
        label: "non-positive concentration",
        input: {
          allocation: EQUAL_ALLOCATION,
          observations: { mode: "increments", batches: [] },
          concentration: 0,
        },
      },
      {
        label: "fractional count",
        input: {
          allocation: EQUAL_ALLOCATION,
          observations: { mode: "increments", batches: [{ control: 1.5 }] },
        },
      },
      {
        label: "undeclared variant",
        input: {
          allocation: EQUAL_ALLOCATION,
          observations: { mode: "increments", batches: [{ holdout: 1 }] },
        },
      },
      {
        label: "revised cumulative counts",
        input: {
          allocation: EQUAL_ALLOCATION,
          observations: {
            mode: "cumulative",
            snapshots: [
              { control: 10, treatment: 10 },
              { control: 9, treatment: 10 },
            ],
          },
        },
      },
    ];

    for (const { label, input } of cases) {
      expect(() => computeSequentialSrm(input), label).toThrow(/Sequential SRM/);
    }
    expect(() =>
      computeSequentialSrm({
        allocation: EQUAL_ALLOCATION,
        observations: {
          mode: "cumulative",
          snapshots: [
            { control: 10, treatment: 10 },
            { control: 9, treatment: 10 },
          ],
        },
      }),
    ).toThrow(/__multiple__/);
  });
});

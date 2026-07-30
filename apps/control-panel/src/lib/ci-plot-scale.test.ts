import { describe, expect, it } from "vitest";
import { ciBoundIsOpen, ciPlotDomain, ciPlotTicks, ciPlotX } from "./ci-plot-scale";

describe("ciPlotDomain", () => {
  it("always contains zero so the Control baseline stays on canvas", () => {
    const domain = ciPlotDomain([{ estimate: 40, lower: 30, upper: 50 }]);
    expect(domain.min).toBeLessThanOrEqual(0);
    expect(domain.max).toBeGreaterThan(50);
  });

  it("ignores unbounded ends rather than collapsing the scale", () => {
    const domain = ciPlotDomain([{ estimate: 5, lower: null, upper: 12 }]);
    expect(Number.isFinite(domain.min)).toBe(true);
    expect(domain.max).toBeGreaterThan(12);
  });

  it("falls back to a readable unit domain when nothing is plottable", () => {
    expect(ciPlotDomain([{ estimate: null, lower: null, upper: null }])).toEqual({
      min: -1,
      max: 1,
    });
  });

  it("pads a zero-width domain so a point estimate is still visible", () => {
    const domain = ciPlotDomain([{ estimate: 0, lower: 0, upper: 0 }]);
    expect(domain.min).toBeLessThan(domain.max);
  });
});

describe("ciPlotTicks", () => {
  it("always includes zero", () => {
    expect(ciPlotTicks({ min: -12, max: 30 })).toContain(0);
  });

  it("stays inside the domain", () => {
    const domain = { min: -12, max: 30 };
    for (const tick of ciPlotTicks(domain)) {
      expect(tick).toBeGreaterThanOrEqual(domain.min);
      expect(tick).toBeLessThanOrEqual(domain.max);
    }
  });
});

describe("ciPlotX", () => {
  it("places the domain ends at the plot ends", () => {
    expect(ciPlotX(-10, { min: -10, max: 10 }, 200)).toBe(0);
    expect(ciPlotX(10, { min: -10, max: 10 }, 200)).toBe(200);
    expect(ciPlotX(0, { min: -10, max: 10 }, 200)).toBe(100);
  });

  it("clamps rather than drawing outside the plot", () => {
    expect(ciPlotX(999, { min: -10, max: 10 }, 200)).toBe(200);
  });
});

describe("ciBoundIsOpen", () => {
  it("treats a null or infinite bound as open", () => {
    expect(ciBoundIsOpen(null)).toBe(true);
    expect(ciBoundIsOpen(Number.POSITIVE_INFINITY)).toBe(true);
    expect(ciBoundIsOpen(-3)).toBe(false);
  });
});

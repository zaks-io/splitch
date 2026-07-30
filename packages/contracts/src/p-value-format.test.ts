import { describe, expect, it } from "vitest";
import { formatPValue } from "./p-value-format";

/**
 * A p-value formatter that collapses two values into one string tells the
 * reader a decision landed somewhere it did not. These cases are the ones the
 * previous `toPrecision(3)` and `<0.0001` renderings got wrong.
 */
describe("formatPValue", () => {
  it("keeps values on opposite sides of the 0.05 threshold distinguishable", () => {
    expect(formatPValue(0.0499)).not.toBe(formatPValue(0.0501));
  });

  it.each([
    [0.0009, 0.0011],
    [0.00001, 0.000011],
    [1e-12, 1e-13],
  ])("keeps %p and %p distinguishable below every rounding floor", (low, high) => {
    expect(formatPValue(low)).not.toBe(formatPValue(high));
  });

  it("renders the extremes on the probability scale, not as counts", () => {
    expect(formatPValue(1)).toBe("1.0");
    expect(formatPValue(0)).toBe("0.0");
  });

  it("round-trips, so the printed string is the number the engine produced", () => {
    for (const value of [0.05, 0.0499, 0.0501, 0.0009, 1e-9, 0.123456789]) {
      expect(Number(formatPValue(value))).toBe(value);
    }
  });
});

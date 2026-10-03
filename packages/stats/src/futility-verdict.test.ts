import { describe, expect, it } from "vitest";
import { classifyMdeExclusionFutility, type FutilityVerdictInput } from "./futility-verdict";

describe("classifyMdeExclusionFutility", () => {
  it.each([
    {
      name: "higher_is_better: upper strictly below MDE is futile",
      input: base({
        desirability: "higher_is_better",
        lower: -0.01,
        upper: 0.01,
        mdeAbsolute: 0.02,
      }),
      verdict: "futile" as const,
    },
    {
      name: "higher_is_better: upper equals MDE is not_futile (closed)",
      input: base({
        desirability: "higher_is_better",
        lower: -0.01,
        upper: 0.02,
        mdeAbsolute: 0.02,
      }),
      verdict: "not_futile" as const,
    },
    {
      name: "higher_is_better: upper above MDE is not_futile",
      input: base({
        desirability: "higher_is_better",
        lower: 0.01,
        upper: 0.05,
        mdeAbsolute: 0.02,
      }),
      verdict: "not_futile" as const,
    },
    {
      name: "lower_is_better: lower strictly above -MDE is futile",
      input: base({
        desirability: "lower_is_better",
        lower: -0.01,
        upper: 0.01,
        mdeAbsolute: 0.02,
      }),
      verdict: "futile" as const,
    },
    {
      name: "lower_is_better: lower equals -MDE is not_futile (closed)",
      input: base({
        desirability: "lower_is_better",
        lower: -0.02,
        upper: 0.01,
        mdeAbsolute: 0.02,
      }),
      verdict: "not_futile" as const,
    },
    {
      name: "lower_is_better: lower below -MDE is not_futile",
      input: base({
        desirability: "lower_is_better",
        lower: -0.05,
        upper: -0.01,
        mdeAbsolute: 0.02,
      }),
      verdict: "not_futile" as const,
    },
  ])("$name", ({ input, verdict }) => {
    const result = classifyMdeExclusionFutility(input);
    expect(result.verdict).toBe(verdict);
    expect(result.because.length).toBeGreaterThan(0);
    expect(result.because.includes("\n")).toBe(false);
  });

  it("fails loud on non-finite bounds", () => {
    expect(() => classifyMdeExclusionFutility(base({ lower: Number.NaN }))).toThrow(
      /lower must be a finite number/,
    );
    expect(() => classifyMdeExclusionFutility(base({ upper: Number.POSITIVE_INFINITY }))).toThrow(
      /upper must be a finite number/,
    );
    expect(() => classifyMdeExclusionFutility(base({ mdeAbsolute: Number.NaN }))).toThrow(
      /mdeAbsolute must be a finite number/,
    );
  });

  it("fails loud when the interval is inverted", () => {
    expect(() => classifyMdeExclusionFutility(base({ lower: 2, upper: 1 }))).toThrow(
      /interval lower \(2\) must be <= upper \(1\)/,
    );
  });

  it("fails loud on a non-positive MDE", () => {
    expect(() => classifyMdeExclusionFutility(base({ mdeAbsolute: 0 }))).toThrow(
      /mdeAbsolute must be a positive finite number/,
    );
    expect(() => classifyMdeExclusionFutility(base({ mdeAbsolute: -0.1 }))).toThrow(
      /mdeAbsolute must be a positive finite number/,
    );
  });

  it("fails loud on an unknown desirability", () => {
    expect(() =>
      classifyMdeExclusionFutility(
        base({ desirability: "sideways" as FutilityVerdictInput["desirability"] }),
      ),
    ).toThrow(/desirability must be "higher_is_better" or "lower_is_better"/);
  });
});

function base(overrides: Partial<FutilityVerdictInput> = {}): FutilityVerdictInput {
  return {
    lower: -0.01,
    upper: 0.01,
    mdeAbsolute: 0.02,
    desirability: "higher_is_better",
    ...overrides,
  };
}

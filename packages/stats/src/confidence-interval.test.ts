import { describe, expect, it } from "vitest";
import { type CIAdapter, type CIParams, isStableCIResult } from "./confidence-interval";
import { FixedHorizonCI } from "./fixed-horizon-ci";
import { SequentialCI } from "./sequential-ci";

const valid: CIParams = {
  estimate: 0.1,
  sampling_var: 0.01,
  n_t: 100,
  n_c: 100,
  alpha: 0.05,
  sample_size_locked: 100,
};

const adapters: Array<{ name: string; adapter: CIAdapter }> = [
  { name: "SequentialCI", adapter: new SequentialCI() },
  { name: "FixedHorizonCI", adapter: new FixedHorizonCI() },
];

describe.each(adapters)("$name common CI invariants", ({ adapter }) => {
  it.each([
    ["estimate must be finite.", { estimate: Number.POSITIVE_INFINITY }],
    ["sampling_var must be finite and non-negative.", { sampling_var: -1 }],
    ["n_t and n_c must be non-negative safe integers.", { n_t: 0.5 }],
    ["alpha must be finite and in (0, 1).", { alpha: 1 }],
  ])("rejects invalid input: %s", (message, patch) => {
    const result = adapter.compute({ ...valid, ...patch });

    expect(result).toMatchObject({
      status: "error",
      error: { code: "INVALID_INPUT", message },
      ci_lower: Number.NEGATIVE_INFINITY,
      ci_upper: Number.POSITIVE_INFINITY,
      p_value: 1,
      boundary: Number.POSITIVE_INFINITY,
    });
  });

  it("keeps warning results decision-ineligible", () => {
    const result = adapter.compute({ ...valid, sampling_var: 0 });

    expect(result).toMatchObject({
      status: "warning",
      ci_lower: Number.NEGATIVE_INFINITY,
      ci_upper: Number.POSITIVE_INFINITY,
      p_value: 1,
      boundary: Number.POSITIVE_INFINITY,
      warnings: [{ code: "ZERO_SAMPLING_VARIANCE" }],
    });
  });
});

describe("finite CI result invariant", () => {
  it("accepts equality only for an exactly zero boundary", () => {
    expect(isStableCIResult(1, 1, 0.5, 1, 0)).toBe(true);
    expect(isStableCIResult(1, 1.2, 0.5, 1, 0.2)).toBe(false);
  });

  it("rejects a non-finite bound or an out-of-range p-value", () => {
    expect(isStableCIResult(Number.NEGATIVE_INFINITY, 1.2, 0.5, 1, 0.2)).toBe(false);
    expect(isStableCIResult(0.8, 1.2, 1.01, 1, 0.2)).toBe(false);
  });
});

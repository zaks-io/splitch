import { describe, expect, it } from "vitest";
import {
  computeFixedHorizonCI,
  FIXED_HORIZON_CI_SOURCE,
  FixedHorizonCI,
} from "./fixed-horizon-ci.js";

describe("FixedHorizonCI", () => {
  const adapter = new FixedHorizonCI();

  it("computes a two-sample z interval only at the locked sample size", () => {
    const result = adapter.compute({
      estimate: 0.12,
      sampling_var: 0.0004,
      n_t: 1_000,
      n_c: 1_000,
      alpha: 0.05,
      sample_size_locked: 1_000,
    });

    expect(result.status).toBe("ok");
    expect(result.mode).toBe("fixed");
    expect(result.peeking_allowed).toBe(false);
    expect(result.source).toEqual(FIXED_HORIZON_CI_SOURCE);
    expect(result.critical_value).toBeCloseTo(1.959963986120195, 12);
    expect(result.boundary).toBeCloseTo(0.0391992797224039, 12);
    expect(result.ci_lower).toBeCloseTo(0.0808007202775961, 12);
    expect(result.ci_upper).toBeCloseTo(0.1591992797224039, 12);
    expect(result.p_value).toBeLessThan(0.000001);
  });

  it("returns an infinite warning interval before the locked read", () => {
    const result = computeFixedHorizonCI({
      estimate: 0.12,
      sampling_var: 0.0004,
      n_t: 900,
      n_c: 1_000,
      alpha: 0.05,
      sample_size_locked: 1_000,
    });

    expect(result.status).toBe("warning");
    expect(result.ci_lower).toBe(Number.NEGATIVE_INFINITY);
    expect(result.ci_upper).toBe(Number.POSITIVE_INFINITY);
    expect(result.p_value).toBe(1);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: "FIXED_HORIZON_NOT_AT_LOCKED_SAMPLE" }),
    );
  });

  it("fails loud without a locked sample size", () => {
    const result = adapter.compute({
      estimate: 0.12,
      sampling_var: 0.0004,
      n_t: 1_000,
      n_c: 1_000,
      alpha: 0.05,
    });

    expect(result.status).toBe("error");
    expect(result.error).toEqual(expect.objectContaining({ code: "FIXED_HORIZON_LOCK_MISSING" }));
    expect(result.peeking_allowed).toBe(false);
  });
});

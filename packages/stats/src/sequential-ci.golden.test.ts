import { describe, expect, it } from "vitest";
import { SequentialCI } from "./sequential-ci";

const GOLDEN_TOLERANCE = 1e-12;

describe("SequentialCI golden fixtures", () => {
  it("matches the documented normal-mixture aCS reference tuple", () => {
    const result = new SequentialCI().compute({
      estimate: 0.12,
      sampling_var: 0.0004,
      n_t: 2_500,
      n_c: 2_500,
      alpha: 0.05,
      target_n: 5_000,
    });

    expect(result.status).toBe("ok");
    expect(result.rho_squared).toBeCloseTo(0.001642393612413651, 15);
    expect(result.boundary).toBeCloseTo(0.06070244826057103, 15);
    expect(result.ci_lower).toBeCloseTo(0.059297551739428966, 15);
    expect(result.ci_upper).toBeCloseTo(0.18070244826057102, 15);
    expect(result.p_value).toBeCloseTo(1.506599493446392e-7, 15);

    expect(Math.abs(result.ci_lower - 0.059297551739428966)).toBeLessThanOrEqual(GOLDEN_TOLERANCE);
    expect(Math.abs(result.ci_upper - 0.18070244826057102)).toBeLessThanOrEqual(GOLDEN_TOLERANCE);
    expect(Math.abs(result.p_value - 1.506599493446392e-7)).toBeLessThanOrEqual(GOLDEN_TOLERANCE);
  });
});

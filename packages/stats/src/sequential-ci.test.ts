import { describe, expect, it } from "vitest";
import {
  computeSequentialCI,
  normalMixtureScale,
  rhoSquaredForTargetN,
  SEQUENTIAL_CI_SOURCE,
  SequentialCI,
} from "./sequential-ci.js";

describe("SequentialCI", () => {
  const adapter = new SequentialCI();

  it("identifies the source-tested normal-mixture aCS family", () => {
    const result = adapter.compute({
      estimate: 0.08,
      sampling_var: 0.0004,
      n_t: 2_500,
      n_c: 2_500,
      alpha: 0.05,
    });

    expect(result.status).toBe("ok");
    expect(result.mode).toBe("sequential");
    expect(result.source).toEqual(SEQUENTIAL_CI_SOURCE);
    expect(result.source.references).toContain("https://arxiv.org/abs/2302.10108");
  });

  it("returns an infinite warning interval when sampling_var is zero", () => {
    const result = adapter.compute({
      estimate: 0,
      sampling_var: 0,
      n_t: 100,
      n_c: 100,
      alpha: 0.05,
    });

    expect(result.status).toBe("warning");
    expect(result.ci_lower).toBe(Number.NEGATIVE_INFINITY);
    expect(result.ci_upper).toBe(Number.POSITIVE_INFINITY);
    expect(result.p_value).toBe(1);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: "ZERO_SAMPLING_VARIANCE" }),
    );
  });

  it("returns an infinite warning interval when either arm has no Exposures", () => {
    const result = adapter.compute({
      estimate: 0.1,
      sampling_var: 0.01,
      n_t: 0,
      n_c: 100,
      alpha: 0.05,
    });

    expect(result.status).toBe("warning");
    expect(result.ci_lower).toBe(Number.NEGATIVE_INFINITY);
    expect(result.ci_upper).toBe(Number.POSITIVE_INFINITY);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: "INSUFFICIENT_SAMPLE" }),
    );
  });

  it("returns an error status instead of a corrupt finite CI on overflow", () => {
    const result = adapter.compute({
      estimate: Number.MAX_VALUE,
      sampling_var: Number.MAX_VALUE,
      n_t: 50,
      n_c: 50,
      alpha: 0.05,
    });

    expect(result.status).toBe("error");
    expect(result.error).toEqual(expect.objectContaining({ code: "NUMERICAL_OVERFLOW" }));
    expect(result.ci_lower).toBe(Number.NEGATIVE_INFINITY);
    expect(result.ci_upper).toBe(Number.POSITIVE_INFINITY);
  });

  it("keeps the p-value inversion aligned with CI exclusion", () => {
    const significant = computeSequentialCI({
      estimate: 0.18,
      sampling_var: 0.0004,
      n_t: 2_500,
      n_c: 2_500,
      alpha: 0.05,
    });
    const notSignificant = computeSequentialCI({
      estimate: 0.04,
      sampling_var: 0.0004,
      n_t: 2_500,
      n_c: 2_500,
      alpha: 0.05,
    });

    expect(significant.ci_lower).toBeGreaterThan(0);
    expect(significant.p_value).toBeLessThanOrEqual(0.05);
    expect(notSignificant.ci_lower).toBeLessThan(0);
    expect(notSignificant.ci_upper).toBeGreaterThan(0);
    expect(notSignificant.p_value).toBeGreaterThan(0.05);
  });

  it("is monotone in alpha for a fixed tuning schedule", () => {
    const n = 1_000;
    const rhoSquared = rhoSquaredForTargetN(0.05, 1_000);

    expect(normalMixtureScale(n, 0.01, rhoSquared)).toBeGreaterThan(
      normalMixtureScale(n, 0.05, rhoSquared),
    );
    expect(normalMixtureScale(n, 0.05, rhoSquared)).toBeGreaterThan(
      normalMixtureScale(n, 0.1, rhoSquared),
    );
  });
});

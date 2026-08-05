import { describe, expect, it } from "vitest";
import { applyDecisionFamilyCorrection } from "../src/decision-family-fdr";
import { computeFixedHorizonCI } from "../src/fixed-horizon-ci";
import { fiellerRelativeCi } from "../src/relative-ci";
import { computeSequentialCI } from "../src/sequential-ci";
import { estimateMetricComparison } from "../src/variance-estimators";
import { comparisonInput, normalDraws, rng } from "./harness";

const ALPHA = 0.05;

describe("Fieller relative interval agrees with the absolute decision", () => {
  it("contains 0% if and only if the decision interval contains 0", () => {
    let checked = 0;
    for (let trial = 0; trial < 1500; trial += 1) {
      const draw = normalDraws(rng(8_000_000 + trial));
      const n = 60 + (trial % 40) * 10;
      const shift = ((trial % 11) - 5) * 0.12;
      const control = Array.from({ length: n }, () => 10 + 3 * draw());
      const treatment = Array.from({ length: n }, () => 10 + shift + 3 * draw());
      const comparison = estimateMetricComparison(
        // biome-ignore lint/suspicious/noExplicitAny: audit harness
        comparisonInput(control, treatment, "count") as any,
      );
      if (comparison.absolute_lift === null || comparison.absolute_lift_sampling_var === null) {
        continue;
      }
      const ci =
        trial % 2 === 0
          ? computeFixedHorizonCI({
              estimate: comparison.absolute_lift,
              sampling_var: comparison.absolute_lift_sampling_var,
              n_t: n,
              n_c: n,
              alpha: ALPHA,
              sample_size_locked: n,
            })
          : computeSequentialCI({
              estimate: comparison.absolute_lift,
              sampling_var: comparison.absolute_lift_sampling_var,
              n_t: n,
              n_c: n,
              alpha: ALPHA,
              target_n: 2 * n,
            });
      if (!Number.isFinite(ci.ci_lower) || !Number.isFinite(ci.ci_upper)) continue;

      const relative = fiellerRelativeCi(comparison, ci);
      const absoluteContainsZero = ci.ci_lower <= 0 && ci.ci_upper >= 0;
      const relativeContainsZero = relative.lower <= 0 && relative.upper >= 0;
      expect(
        relativeContainsZero,
        `trial ${trial}: abs=[${ci.ci_lower},${ci.ci_upper}] rel=[${relative.lower},${relative.upper}]`,
      ).toBe(absoluteContainsZero);
      checked += 1;
    }
    console.log(`Fieller/absolute agreement checked on ${checked} comparisons`);
    expect(checked).toBeGreaterThan(1000);
  });

  it("brackets the point estimate", () => {
    for (let trial = 0; trial < 400; trial += 1) {
      const draw = normalDraws(rng(9_000_000 + trial));
      const n = 200;
      const control = Array.from({ length: n }, () => 10 + 3 * draw());
      const treatment = Array.from({ length: n }, () => 10.4 + 3 * draw());
      const comparison = estimateMetricComparison(
        // biome-ignore lint/suspicious/noExplicitAny: audit harness
        comparisonInput(control, treatment, "count") as any,
      );
      if (comparison.absolute_lift === null || comparison.absolute_lift_sampling_var === null) {
        continue;
      }
      const ci = computeFixedHorizonCI({
        estimate: comparison.absolute_lift,
        sampling_var: comparison.absolute_lift_sampling_var,
        n_t: n,
        n_c: n,
        alpha: ALPHA,
        sample_size_locked: n,
      });
      const relative = fiellerRelativeCi(comparison, ci);
      const point = comparison.relative_lift_pct;
      if (point === null) continue;
      expect(relative.lower).toBeLessThanOrEqual(point + 1e-9);
      expect(relative.upper).toBeGreaterThanOrEqual(point - 1e-9);
    }
  });

  it("matches a hand-computed Fieller interval", () => {
    // C = 10, T = 12, vC = 0.25, vT = 0.36, k = 1.959963984540054.
    // a = 100 - k^2*0.25, b = -240, c = 144 - k^2*0.36
    const k = 1.959963984540054;
    const vC = 0.25;
    const vT = 0.36;
    const absVar = vC + vT;
    const halfWidth = k * Math.sqrt(absVar);
    const a = 100 - k * k * vC;
    const b = -240;
    const c = 144 - k * k * vT;
    const root = Math.sqrt(b * b - 4 * a * c);
    const expectedLower = ((-b - root) / (2 * a) - 1) * 100;
    const expectedUpper = ((-b + root) / (2 * a) - 1) * 100;

    const bounds = fiellerRelativeCi(
      {
        metric_id: "m",
        metric_type: "count",
        control: { point_estimate: 10 },
        treatment: { point_estimate: 12 },
        absolute_lift_var_components: { control: vC, treatment: vT },
        absolute_lift_sampling_var: absVar,
        // biome-ignore lint/suspicious/noExplicitAny: audit harness
      } as any,
      // biome-ignore lint/suspicious/noExplicitAny: audit harness
      { ci_lower: 2 - halfWidth, ci_upper: 2 + halfWidth } as any,
    );

    expect(bounds.lower).toBeCloseTo(expectedLower, 9);
    expect(bounds.upper).toBeCloseTo(expectedUpper, 9);
    // Independent sanity: 20% lift, delta-method SE gives roughly +-15%.
    expect(bounds.lower).toBeGreaterThan(0);
    expect(bounds.upper).toBeGreaterThan(bounds.lower);
  });
});

describe("p-value inverts its own confidence interval", () => {
  // A p-value is only meaningful if p <= alpha exactly when the alpha-level
  // interval excludes 0. Both adapters compute the two separately, so the
  // duality has to be checked rather than assumed.
  const ALPHAS = [0.2, 0.1, 0.05, 0.025, 0.01, 0.005, 0.001];

  it("holds for the sequential adapter across alphas and sample sizes", () => {
    let checked = 0;
    for (let trial = 0; trial < 600; trial += 1) {
      const draw = normalDraws(rng(17_000_000 + trial));
      const n = 100 + (trial % 20) * 100;
      const shift = ((trial % 13) - 6) * 0.1;
      const control = Array.from({ length: n }, () => 10 + 3 * draw());
      const treatment = Array.from({ length: n }, () => 10 + shift + 3 * draw());
      const comparison = estimateMetricComparison(
        // biome-ignore lint/suspicious/noExplicitAny: audit harness
        comparisonInput(control, treatment, "count") as any,
      );
      if (comparison.absolute_lift === null || comparison.absolute_lift_sampling_var === null) {
        continue;
      }
      const base = {
        estimate: comparison.absolute_lift,
        sampling_var: comparison.absolute_lift_sampling_var,
        n_t: n,
        n_c: n,
        target_n: 4000,
      };
      // The reported p-value comes from the default alpha; the duality claim is
      // that it ranks identically against every other alpha's interval.
      const reported = computeSequentialCI({ ...base, alpha: 0.05 }).p_value;
      for (const alpha of ALPHAS) {
        const ci = computeSequentialCI({ ...base, alpha });
        const excludesZero = ci.ci_lower > 0 || ci.ci_upper < 0;
        expect(
          excludesZero,
          `trial ${trial} n=${n} alpha=${alpha}: p=${reported} ci=[${ci.ci_lower},${ci.ci_upper}]`,
        ).toBe(reported <= alpha);
        checked += 1;
      }
    }
    console.log(`sequential p/CI duality checked on ${checked} (comparison, alpha) pairs`);
    expect(checked).toBeGreaterThan(4000);
  });

  it("holds for the fixed-horizon adapter across alphas", () => {
    for (let trial = 0; trial < 400; trial += 1) {
      const draw = normalDraws(rng(18_000_000 + trial));
      const n = 500;
      const shift = ((trial % 13) - 6) * 0.1;
      const control = Array.from({ length: n }, () => 10 + 3 * draw());
      const treatment = Array.from({ length: n }, () => 10 + shift + 3 * draw());
      const comparison = estimateMetricComparison(
        // biome-ignore lint/suspicious/noExplicitAny: audit harness
        comparisonInput(control, treatment, "count") as any,
      );
      if (comparison.absolute_lift === null || comparison.absolute_lift_sampling_var === null) {
        continue;
      }
      const base = {
        estimate: comparison.absolute_lift,
        sampling_var: comparison.absolute_lift_sampling_var,
        n_t: n,
        n_c: n,
        sample_size_locked: n,
      };
      const reported = computeFixedHorizonCI({ ...base, alpha: 0.05 }).p_value;
      for (const alpha of ALPHAS) {
        const ci = computeFixedHorizonCI({ ...base, alpha });
        const excludesZero = ci.ci_lower > 0 || ci.ci_upper < 0;
        expect(excludesZero, `trial ${trial} alpha=${alpha}: p=${reported}`).toBe(
          reported <= alpha,
        );
      }
    }
  });
});

/** Reference BH implementation written from the 1995 paper definition. */
function referenceBH(pValues: readonly number[], alpha: number): boolean[] {
  const m = pValues.length;
  const order = pValues.map((p, i) => ({ p, i })).sort((l, r) => l.p - r.p);
  let k = 0;
  for (let rank = 1; rank <= m; rank += 1) {
    const entry = order[rank - 1];
    if (entry && entry.p <= (rank / m) * alpha) k = rank;
  }
  const rejected = new Array<boolean>(m).fill(false);
  for (let rank = 0; rank < k; rank += 1) {
    const entry = order[rank];
    if (entry) rejected[entry.i] = true;
  }
  return rejected;
}

describe("Benjamini-Hochberg correction", () => {
  it("matches a reference implementation on random p-value families", () => {
    for (let trial = 0; trial < 500; trial += 1) {
      const next = rng(10_000_000 + trial);
      const m = 1 + (trial % 12);
      const pValues = Array.from({ length: m }, () => (next() < 0.3 ? next() * 0.05 : next()));
      const family = pValues.map((_p, i) => ({ metric_id: `m${i}`, variant: "treatment" }));
      const armResults = pValues.map((p, i) => ({
        variant: "treatment",
        metric_id: `m${i}`,
        sample_size_n: 100,
        point_estimate: 1,
        relative_lift_pct: 1,
        ci_lower: 0,
        ci_upper: 2,
        p_value: p,
        is_significant: false,
        in_bh_family: false,
        exploratory: true,
        decision_valid: false,
        status: "ready" as const,
        variance_techniques: {
          winsorized: false,
          winsorize_pct: null,
          winsorize_cap: null,
          cuped_applied: false,
          cuped_method: null,
          cuped_attribute: null,
          cuped_attribute_source: null,
          cuped_coverage_pct: null,
          delta_method: false,
        },
      }));

      const out = applyDecisionFamilyCorrection({
        arm_results: armResults,
        decision_family: family,
        confidence_level: 0.95,
        control_variant: "control",
      });
      const expected = referenceBH(pValues, 0.05);
      const actual = out.arm_results.map((r) => r.is_significant);
      expect(actual).toEqual(expected);
    }
  });

  it("controls FDR under a mix of true nulls and real effects", () => {
    const TRIALS = 4000;
    const M_NULL = 8;
    const M_ALT = 2;
    let falseDiscoveryProportionSum = 0;

    for (let trial = 0; trial < TRIALS; trial += 1) {
      const next = rng(11_000_000 + trial);
      // Nulls are uniform; alternatives are concentrated near zero.
      const nulls = Array.from({ length: M_NULL }, () => next());
      const alts = Array.from({ length: M_ALT }, () => next() * 0.002);
      const pValues = [...nulls, ...alts];
      const rejected = referenceBH(pValues, 0.05);
      const rejectedCount = rejected.filter(Boolean).length;
      const falseCount = rejected.slice(0, M_NULL).filter(Boolean).length;
      falseDiscoveryProportionSum += rejectedCount === 0 ? 0 : falseCount / rejectedCount;
    }

    const fdr = falseDiscoveryProportionSum / TRIALS;
    console.log(`reference BH FDR with ${M_NULL} nulls / ${M_ALT} alts: ${fdr}`);
    expect(fdr).toBeLessThan(0.05);
  });
});

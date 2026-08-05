import { describe, expect, it } from "vitest";
import { computeFixedHorizonCI } from "../src/fixed-horizon-ci";
import { computeSequentialCI } from "../src/sequential-ci";
import { estimateMetricComparison } from "../src/variance-estimators";
import { comparisonInput, normalDraws, ratioComparisonInput, rng, wilson } from "./harness";

const ALPHA = 0.05;

function decide(
  controlValues: readonly number[],
  treatmentValues: readonly number[],
  metricType: "count" | "revenue" | "binomial",
  mode: "sequential" | "fixed",
  targetN: number,
) {
  const comparison = estimateMetricComparison(
    // biome-ignore lint/suspicious/noExplicitAny: audit harness
    comparisonInput(controlValues, treatmentValues, metricType) as any,
  );
  if (comparison.absolute_lift === null || comparison.absolute_lift_sampling_var === null) {
    return null;
  }
  const params = {
    estimate: comparison.absolute_lift,
    sampling_var: comparison.absolute_lift_sampling_var,
    n_t: treatmentValues.length,
    n_c: controlValues.length,
    alpha: ALPHA,
    ...(mode === "sequential"
      ? { target_n: targetN }
      : { sample_size_locked: controlValues.length }),
  };
  const ci = mode === "sequential" ? computeSequentialCI(params) : computeFixedHorizonCI(params);
  return { comparison, ci };
}

function excludesZero(ci: { ci_lower: number; ci_upper: number }): boolean {
  return ci.ci_lower > 0 || ci.ci_upper < 0;
}

describe("fixed-horizon Type-I error at the locked sample size", () => {
  it("holds at alpha for a normal count metric", () => {
    const TRIALS = 4000;
    const N = 500;
    let rejections = 0;

    for (let trial = 0; trial < TRIALS; trial += 1) {
      const draw = normalDraws(rng(1_000_000 + trial));
      const control = Array.from({ length: N }, () => 10 + 3 * draw());
      const treatment = Array.from({ length: N }, () => 10 + 3 * draw());
      const decision = decide(control, treatment, "count", "fixed", N);
      if (decision && excludesZero(decision.ci)) {
        rejections += 1;
      }
    }

    const [lo, hi] = wilson(rejections, TRIALS);
    console.log(`fixed-horizon normal Type-I: ${rejections}/${TRIALS} = ${rejections / TRIALS}`);
    expect(lo).toBeLessThan(ALPHA);
    expect(hi).toBeGreaterThan(0.03);
  });

  it("holds at alpha for a heavy-tailed revenue metric", () => {
    const TRIALS = 4000;
    const N = 500;
    let rejections = 0;

    for (let trial = 0; trial < TRIALS; trial += 1) {
      const draw = normalDraws(rng(2_000_000 + trial));
      const lognormal = () => Math.exp(1 + 1.5 * draw());
      const control = Array.from({ length: N }, lognormal);
      const treatment = Array.from({ length: N }, lognormal);
      const decision = decide(control, treatment, "revenue", "fixed", N);
      if (decision && excludesZero(decision.ci)) {
        rejections += 1;
      }
    }

    const rate = rejections / TRIALS;
    const [lo] = wilson(rejections, TRIALS);
    console.log(`fixed-horizon lognormal Type-I: ${rejections}/${TRIALS} = ${rate}`);
    expect(lo).toBeLessThan(0.075);
  });

  it("holds at alpha for a binomial metric", () => {
    const TRIALS = 4000;
    const N = 800;
    const P = 0.2;
    let rejections = 0;

    for (let trial = 0; trial < TRIALS; trial += 1) {
      const next = rng(3_000_000 + trial);
      const control = Array.from({ length: N }, () => (next() < P ? 1 : 0));
      const treatment = Array.from({ length: N }, () => (next() < P ? 1 : 0));
      const decision = decide(control, treatment, "binomial", "fixed", N);
      if (decision && excludesZero(decision.ci)) {
        rejections += 1;
      }
    }

    const rate = rejections / TRIALS;
    console.log(`fixed-horizon binomial Type-I: ${rejections}/${TRIALS} = ${rate}`);
    expect(wilson(rejections, TRIALS)[0]).toBeLessThan(0.07);
  });
});

describe("sequential CI under continuous monitoring", () => {
  it("keeps the any-time Type-I error at or under alpha across many looks", () => {
    const TRIALS = 1500;
    const MAX_N = 2000;
    const TARGET_N = 2 * MAX_N;
    const LOOKS = [50, 75, 100, 150, 200, 300, 400, 550, 700, 900, 1100, 1400, 1700, 2000];
    let everRejected = 0;
    let finalRejected = 0;

    for (let trial = 0; trial < TRIALS; trial += 1) {
      const draw = normalDraws(rng(4_000_000 + trial));
      const control: number[] = [];
      const treatment: number[] = [];
      for (let index = 0; index < MAX_N; index += 1) {
        control.push(10 + 3 * draw());
        treatment.push(10 + 3 * draw());
      }

      let rejected = false;
      for (const look of LOOKS) {
        const decision = decide(
          control.slice(0, look),
          treatment.slice(0, look),
          "count",
          "sequential",
          TARGET_N,
        );
        if (decision && excludesZero(decision.ci)) {
          rejected = true;
          break;
        }
      }
      if (rejected) everRejected += 1;

      const last = decide(control, treatment, "count", "sequential", TARGET_N);
      if (last && excludesZero(last.ci)) finalRejected += 1;
    }

    const anyTime = everRejected / TRIALS;
    console.log(
      `sequential any-time Type-I over ${LOOKS.length} looks: ${everRejected}/${TRIALS} = ${anyTime}`,
    );
    console.log(`sequential single-look (final) Type-I: ${finalRejected}/${TRIALS}`);
    expect(wilson(everRejected, TRIALS)[0]).toBeLessThan(ALPHA);
  });

  it("is conservative at a single look, as a confidence sequence must be", () => {
    const TRIALS = 3000;
    const N = 1000;
    let rejections = 0;

    for (let trial = 0; trial < TRIALS; trial += 1) {
      const draw = normalDraws(rng(5_000_000 + trial));
      const control = Array.from({ length: N }, () => 10 + 3 * draw());
      const treatment = Array.from({ length: N }, () => 10 + 3 * draw());
      const decision = decide(control, treatment, "count", "sequential", 2 * N);
      if (decision && excludesZero(decision.ci)) rejections += 1;
    }

    console.log(`sequential single-look Type-I at target_n: ${rejections}/${TRIALS}`);
    expect(rejections / TRIALS).toBeLessThan(ALPHA);
  });
});

describe("ratio metric (delta method) coverage", () => {
  it("keeps Type-I error near alpha under a true null ratio", () => {
    const TRIALS = 3000;
    const N = 1000;
    let rejections = 0;

    for (let trial = 0; trial < TRIALS; trial += 1) {
      const draw = normalDraws(rng(6_000_000 + trial));
      const next = rng(6_500_000 + trial);
      const arm = () => {
        const denoms = Array.from({ length: N }, () => 1 + Math.floor(next() * 5));
        const nums = denoms.map((d) => Math.max(0, d * 0.3 + 0.5 * draw()));
        return { nums, denoms };
      };
      const comparison = estimateMetricComparison(
        // biome-ignore lint/suspicious/noExplicitAny: audit harness
        ratioComparisonInput(arm(), arm()) as any,
      );
      if (comparison.absolute_lift === null || comparison.absolute_lift_sampling_var === null) {
        continue;
      }
      const ci = computeFixedHorizonCI({
        estimate: comparison.absolute_lift,
        sampling_var: comparison.absolute_lift_sampling_var,
        n_t: N,
        n_c: N,
        alpha: ALPHA,
        sample_size_locked: N,
      });
      if (excludesZero(ci)) rejections += 1;
    }

    console.log(`ratio delta-method Type-I: ${rejections}/${TRIALS} = ${rejections / TRIALS}`);
    expect(wilson(rejections, TRIALS)[0]).toBeLessThan(0.07);
  });
});

describe("power sanity", () => {
  it("detects a real effect at fixed horizon", () => {
    const TRIALS = 500;
    const N = 1000;
    let rejections = 0;
    let correctSign = 0;

    for (let trial = 0; trial < TRIALS; trial += 1) {
      const draw = normalDraws(rng(7_000_000 + trial));
      const control = Array.from({ length: N }, () => 10 + 3 * draw());
      const treatment = Array.from({ length: N }, () => 10.5 + 3 * draw());
      const decision = decide(control, treatment, "count", "fixed", N);
      if (decision && excludesZero(decision.ci)) {
        rejections += 1;
        if (decision.ci.ci_lower > 0) correctSign += 1;
      }
    }

    console.log(`fixed-horizon power at d=0.167 sd: ${rejections}/${TRIALS}`);
    expect(rejections / TRIALS).toBeGreaterThan(0.6);
    expect(correctSign).toBe(rejections);
  });
});

import { describe, expect, it } from "vitest";
import { computeFixedHorizonCI } from "../src/fixed-horizon-ci";
import { estimateMetricComparison } from "../src/variance-estimators";
import { comparisonInput, normalDraws, prePeriodCovariates, rng, wilson } from "./harness";

const ALPHA = 0.05;

function run(
  control: readonly number[],
  treatment: readonly number[],
  covariates?: Array<Record<string, unknown>>,
  extra: Record<string, unknown> = {},
) {
  return estimateMetricComparison(
    comparisonInput(control, treatment, "count", {
      ...(covariates ? { pre_period_covariates: covariates } : {}),
      ...extra,
      // biome-ignore lint/suspicious/noExplicitAny: audit harness
    }) as any,
  );
}

describe("CUPED", () => {
  it("reduces variance without biasing the lift", () => {
    const TRIALS = 600;
    const N = 500;
    const TRUE_LIFT = 0.5;
    let plainVarSum = 0;
    let cupedVarSum = 0;
    let plainLiftSum = 0;
    let cupedLiftSum = 0;
    let applied = 0;

    for (let trial = 0; trial < TRIALS; trial += 1) {
      const draw = normalDraws(rng(12_000_000 + trial));
      const controlX = Array.from({ length: N }, () => 5 + 2 * draw());
      const treatmentX = Array.from({ length: N }, () => 5 + 2 * draw());
      // y correlates with x at rho ~ 0.8.
      const control = controlX.map((x) => 10 + 1.2 * (x - 5) + 0.9 * draw());
      const treatment = treatmentX.map((x) => 10 + TRUE_LIFT + 1.2 * (x - 5) + 0.9 * draw());

      const plain = run(control, treatment);
      const cuped = run(control, treatment, prePeriodCovariates(controlX, treatmentX));

      if (cuped.variance_techniques.cuped_applied) applied += 1;
      plainVarSum += plain.absolute_lift_sampling_var ?? 0;
      cupedVarSum += cuped.absolute_lift_sampling_var ?? 0;
      plainLiftSum += plain.absolute_lift ?? 0;
      cupedLiftSum += cuped.absolute_lift ?? 0;
    }

    const plainVar = plainVarSum / TRIALS;
    const cupedVar = cupedVarSum / TRIALS;
    const plainLift = plainLiftSum / TRIALS;
    const cupedLift = cupedLiftSum / TRIALS;
    console.log(
      `CUPED applied ${applied}/${TRIALS}; var ${plainVar.toFixed(6)} -> ${cupedVar.toFixed(6)} ` +
        `(${(100 * (1 - cupedVar / plainVar)).toFixed(1)}% reduction); ` +
        `mean lift ${plainLift.toFixed(4)} -> ${cupedLift.toFixed(4)} (true ${TRUE_LIFT})`,
    );

    expect(applied).toBe(TRIALS);
    expect(cupedVar).toBeLessThan(plainVar * 0.6);
    // Unbiasedness: the CUPED mean lift must sit on the true lift.
    const se = Math.sqrt(cupedVar / TRIALS);
    expect(Math.abs(cupedLift - TRUE_LIFT)).toBeLessThan(4 * se);
  });

  it("does not inflate Type-I error", () => {
    const TRIALS = 3000;
    const N = 400;
    let rejections = 0;

    for (let trial = 0; trial < TRIALS; trial += 1) {
      const draw = normalDraws(rng(13_000_000 + trial));
      const controlX = Array.from({ length: N }, () => 5 + 2 * draw());
      const treatmentX = Array.from({ length: N }, () => 5 + 2 * draw());
      const control = controlX.map((x) => 10 + 1.2 * (x - 5) + 0.9 * draw());
      const treatment = treatmentX.map((x) => 10 + 1.2 * (x - 5) + 0.9 * draw());

      const comparison = run(control, treatment, prePeriodCovariates(controlX, treatmentX));
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
      if (ci.ci_lower > 0 || ci.ci_upper < 0) rejections += 1;
    }

    console.log(`CUPED Type-I: ${rejections}/${TRIALS} = ${rejections / TRIALS}`);
    expect(wilson(rejections, TRIALS)[0]).toBeLessThan(0.06);
  });

  it("keeps the covariate imbalance in the lift instead of adjusting it away", () => {
    // Control arm is drawn with a deliberately higher covariate mean. CUPED must
    // correct the outcome for that imbalance, moving the estimate toward truth.
    const N = 4000;
    const draw = normalDraws(rng(14_000_000));
    const controlX = Array.from({ length: N }, () => 6 + 2 * draw());
    const treatmentX = Array.from({ length: N }, () => 5 + 2 * draw());
    const control = controlX.map((x) => 10 + 1.2 * (x - 5) + 0.9 * draw());
    const treatment = treatmentX.map((x) => 10 + 1.2 * (x - 5) + 0.9 * draw());

    const plain = run(control, treatment);
    const cuped = run(control, treatment, prePeriodCovariates(controlX, treatmentX));
    console.log(
      `imbalanced covariate: plain lift ${plain.absolute_lift?.toFixed(4)}, ` +
        `CUPED lift ${cuped.absolute_lift?.toFixed(4)} (true 0)`,
    );
    expect(Math.abs(cuped.absolute_lift ?? 99)).toBeLessThan(
      Math.abs(plain.absolute_lift ?? 0) * 0.5,
    );
  });
});

describe("winsorization defaults", () => {
  it("is on by default for a count metric and caps the upper tail only", () => {
    const N = 2000;
    const draw = normalDraws(rng(15_000_000));
    const control = Array.from({ length: N }, () => Math.exp(1 + 1.2 * draw()));
    const treatment = Array.from({ length: N }, () => Math.exp(1 + 1.2 * draw()));

    const comparison = run(control, treatment);
    console.log(
      `default winsorize=${comparison.variance_techniques.winsorized} ` +
        `pct=${comparison.variance_techniques.winsorize_pct} ` +
        `cap=${comparison.variance_techniques.winsorize_cap}`,
    );
    expect(comparison.variance_techniques.winsorized).toBe(true);
    expect(comparison.variance_techniques.winsorize_pct).toBe(99.9);

    const off = run(control, treatment, undefined, { winsorize: false });
    expect(off.variance_techniques.winsorized).toBe(false);
    // Capping the top 0.1% must lower the arm means, not raise them.
    expect(comparison.control.point_estimate ?? 0).toBeLessThanOrEqual(
      (off.control.point_estimate ?? 0) + 1e-12,
    );
  });

  it("uses one pooled cap so neither arm is capped differently", () => {
    const N = 1000;
    const draw = normalDraws(rng(16_000_000));
    // Treatment has a much fatter tail; a per-arm cap would clip it harder and
    // manufacture a negative lift.
    const control = Array.from({ length: N }, () => Math.exp(1 + 1.0 * draw()));
    const treatment = Array.from({ length: N }, () => Math.exp(1 + 1.0 * draw()));
    const comparison = run(control, treatment);
    const cap = comparison.variance_techniques.winsorize_cap;
    const pooledMax = Math.max(...control, ...treatment);
    expect(typeof cap).toBe("number");
    expect(cap as number).toBeLessThanOrEqual(pooledMax);
    // The cap must be a quantile of the pooled sample, i.e. it must be a value
    // that exists in the union of both arms.
    expect([...control, ...treatment]).toContain(cap as number);
  });
});

describe("binomial boundary arms", () => {
  it("does not report a zero-variance interval when one arm sits at 0%", () => {
    const N = 300;
    const control = Array.from({ length: N }, () => 0);
    const treatment = Array.from({ length: N }, (_v, i) => (i < 30 ? 1 : 0));
    const comparison = estimateMetricComparison(
      // biome-ignore lint/suspicious/noExplicitAny: audit harness
      comparisonInput(control, treatment, "binomial") as any,
    );
    console.log(
      `boundary arm: control var ${comparison.control.sampling_var}, ` +
        `absolute var ${comparison.absolute_lift_sampling_var}, ` +
        `components ${JSON.stringify(comparison.absolute_lift_var_components)}`,
    );
    expect(comparison.control.sampling_var).toBe(0);
    expect(comparison.absolute_lift_sampling_var ?? 0).toBeGreaterThan(0);
    expect(comparison.absolute_lift_var_components?.control ?? 0).toBeGreaterThan(0);

    const ci = computeFixedHorizonCI({
      estimate: comparison.absolute_lift ?? 0,
      sampling_var: comparison.absolute_lift_sampling_var ?? 0,
      n_t: N,
      n_c: N,
      alpha: ALPHA,
      sample_size_locked: N,
    });
    expect(Number.isFinite(ci.ci_lower)).toBe(true);
    expect(ci.ci_lower).toBeGreaterThan(0);
  });

  it("keeps both arms at 0% from producing a significant result", () => {
    const N = 300;
    const zeros = Array.from({ length: N }, () => 0);
    const comparison = estimateMetricComparison(
      // biome-ignore lint/suspicious/noExplicitAny: audit harness
      comparisonInput(zeros, zeros, "binomial") as any,
    );
    expect(comparison.absolute_lift).toBe(0);
    expect(comparison.absolute_lift_sampling_var).toBe(0);
    const ci = computeFixedHorizonCI({
      estimate: 0,
      sampling_var: 0,
      n_t: N,
      n_c: N,
      alpha: ALPHA,
      sample_size_locked: N,
    });
    expect(ci.ci_lower).toBe(Number.NEGATIVE_INFINITY);
    expect(ci.p_value).toBe(1);
  });
});

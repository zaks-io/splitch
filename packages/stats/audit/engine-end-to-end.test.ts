import type { StatsInput } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { analyzeStats } from "../src/stats-engine";
import { checkSrmHealth } from "../src/srm-checker";
import { exposuresFor, METRIC_ID, metricRowsFor, normalDraws, rng, RUN_ID } from "./harness";

function engineInput(
  arms: Array<{ variant: string; values: number[] }>,
  overrides: Partial<StatsInput> = {},
): StatsInput {
  const allocationShare = 100 / arms.length;
  const allocation = Object.fromEntries(arms.map((a) => [a.variant, allocationShare]));
  const base: StatsInput = {
    run_id: RUN_ID,
    confidence_level: 0.95,
    horizon: "sequential",
    allocation,
    control_variant: "control",
    decision_family: arms
      .filter((a) => a.variant !== "control")
      .map((a) => ({ metric_id: METRIC_ID, variant: a.variant })),
    guardrail_decisions: [],
    metric_variance_config: [],
    exposures: exposuresFor(arms),
    metric_values: metricRowsFor(arms, "count"),
  };
  return { ...base, ...overrides };
}

describe("analyzeStats end-to-end coherence", () => {
  it("keeps p_value, is_significant and the published interval in agreement", async () => {
    let significantCount = 0;
    for (let trial = 0; trial < 200; trial += 1) {
      const draw = normalDraws(rng(20_000_000 + trial));
      const n = 400;
      const shift = ((trial % 7) - 3) * 0.25;
      const input = engineInput([
        { variant: "control", values: Array.from({ length: n }, () => 10 + 3 * draw()) },
        {
          variant: "treatment",
          values: Array.from({ length: n }, () => 10 + shift + 3 * draw()),
        },
      ]);
      const out = await analyzeStats(input);
      const treatment = out.arm_results.find((r) => r.variant === "treatment");
      expect(treatment).toBeDefined();
      if (!treatment) continue;

      // Family of size 1: BH at m=1 is just p <= alpha.
      expect(treatment.is_significant).toBe(treatment.p_value <= 0.05);
      expect(treatment.in_bh_family).toBe(true);
      expect(treatment.decision_valid).toBe(true);

      if (treatment.ci_lower !== null && treatment.ci_upper !== null) {
        const relativeContainsZero = treatment.ci_lower <= 0 && treatment.ci_upper >= 0;
        expect(
          relativeContainsZero,
          `trial ${trial}: p=${treatment.p_value} ci=[${treatment.ci_lower},${treatment.ci_upper}]`,
        ).toBe(!treatment.is_significant);
      }
      if (treatment.is_significant) significantCount += 1;
    }
    console.log(`e2e: ${significantCount}/200 significant across the shift sweep`);
    expect(significantCount).toBeGreaterThan(0);
  });

  // Regression pin. The engine once published the Control arm from the first
  // comparison alone while pooling winsorization per (Control, Treatment) pair,
  // so renaming a Treatment moved the reported baseline. Winsorization and the
  // CUPED fit now span every arm and the Control arm is estimated once.
  it("reports a control arm estimate independent of treatment ordering", async () => {
    const draw = normalDraws(rng(21_000_000));
    const n = 800;
    const control = Array.from({ length: n }, () => Math.exp(2 + 1.0 * draw()));
    // Two Treatments with very different tails, so the pooled cap differs.
    const mild = Array.from({ length: n }, () => Math.exp(2 + 1.0 * draw()));
    const heavy = Array.from({ length: n }, () => Math.exp(2 + 2.2 * draw()));

    const controlEstimate = async (winsorizePct: number, heavySortsFirst: boolean) => {
      const output = await analyzeStats(
        engineInput(
          [
            { variant: "control", values: control },
            { variant: "a_first", values: heavySortsFirst ? heavy : mild },
            { variant: "z_second", values: heavySortsFirst ? mild : heavy },
          ],
          {
            metric_variance_config: [
              {
                metric_id: METRIC_ID,
                winsorize: true,
                winsorize_pct: winsorizePct,
                cuped: false,
                cuped_coverage_threshold_pct: 70,
              },
            ],
          },
        ),
      );
      return output.arm_results.find((r) => r.variant === "control");
    };

    for (const pct of [99.9, 99, 95]) {
      const mildFirst = await controlEstimate(pct, false);
      const heavyFirst = await controlEstimate(pct, true);
      const drift = Math.abs((mildFirst?.point_estimate ?? 0) - (heavyFirst?.point_estimate ?? 0));
      console.log(
        `winsorize_pct=${pct}: control point estimate ${mildFirst?.point_estimate} vs ` +
          `${heavyFirst?.point_estimate} (drift ${drift.toFixed(4)}); ` +
          `caps ${mildFirst?.variance_techniques.winsorize_cap} vs ` +
          `${heavyFirst?.variance_techniques.winsorize_cap}`,
      );
      expect(mildFirst?.point_estimate).toBeCloseTo(heavyFirst?.point_estimate ?? -1, 6);
    }
  });

  it("applies BH across a multi-metric decision family", async () => {
    const draw = normalDraws(rng(22_000_000));
    const n = 500;
    const arms = [
      { variant: "control", values: Array.from({ length: n }, () => 10 + 3 * draw()) },
      { variant: "treatment", values: Array.from({ length: n }, () => 10.6 + 3 * draw()) },
    ];
    const exposures = exposuresFor(arms);
    const metricIds = ["m0", "m1", "m2", "m3", "m4"];
    const metricValues = metricIds.flatMap((metricId) =>
      arms.flatMap((arm) =>
        arm.values.map((value, index) => ({
          targeting_key_hash: `${arm.variant}_${index}`,
          run_id: RUN_ID,
          metric_id: metricId,
          metric_type: "count" as const,
          // Only m0 carries the effect; the rest are pure noise.
          value: metricId === "m0" ? value : 10 + 3 * draw(),
          in_window: true,
        })),
      ),
    );

    const input: StatsInput = {
      run_id: RUN_ID,
      confidence_level: 0.95,
      horizon: "sequential",
      allocation: { control: 50, treatment: 50 },
      control_variant: "control",
      decision_family: metricIds.map((metric_id) => ({ metric_id, variant: "treatment" })),
      guardrail_decisions: [],
      metric_variance_config: [],
      exposures,
      metric_values: metricValues,
    };
    const out = await analyzeStats(input);

    const treatments = out.arm_results.filter((r) => r.variant === "treatment");
    expect(treatments).toHaveLength(5);
    const pValues = treatments.map((r) => r.p_value).sort((l, r) => l - r);
    console.log(`BH family p-values: ${pValues.map((p) => p.toExponential(2)).join(", ")}`);
    for (const result of treatments) {
      expect(result.in_bh_family).toBe(true);
      // Every rejection must clear its own BH threshold.
      if (result.is_significant) {
        const rank = pValues.indexOf(result.p_value) + 1;
        expect(result.p_value).toBeLessThanOrEqual((rank / 5) * 0.05);
      }
    }
  });
});

describe("fixed horizon in practice", () => {
  const LOCKED = 400;
  // One dataset, sampled in exposure order, so a longer Run is literally the
  // shorter Run plus later arrivals.
  const draw = normalDraws(rng(23_000_000));
  const CONTROL_VALUES = Array.from({ length: 600 }, () => 10 + 3 * draw());
  const TREATMENT_VALUES = Array.from({ length: 600 }, () => 11.5 + 3 * draw());

  const fixedRun = (nc: number, nt: number) =>
    engineInput(
      [
        { variant: "control", values: CONTROL_VALUES.slice(0, nc) },
        { variant: "treatment", values: TREATMENT_VALUES.slice(0, nt) },
      ],
      { horizon: "fixed", sample_size_locked: LOCKED },
    );
  const treatmentOf = async (nc: number, nt: number) =>
    (await analyzeStats(fixedRun(nc, nt))).arm_results.find((r) => r.variant === "treatment");

  it("decides when both arms land exactly on sample_size_locked", async () => {
    const result = await treatmentOf(LOCKED, LOCKED);
    console.log(
      `fixed @ exactly locked: status=${result?.status} p=${result?.p_value} ` +
        `significant=${result?.is_significant}`,
    );
    expect(result?.status).toBe("ready");
    expect(result?.is_significant).toBe(true);
  });

  it("stays running until both arms reach the locked sample size", async () => {
    const short = await treatmentOf(LOCKED - 1, LOCKED);
    console.log(`fixed @ locked-1 in one arm: status=${short?.status} p=${short?.p_value}`);
    expect(short?.status).toBe("running");
  });

  // Regression pin. The engine once demanded n_t === n_c === sample_size_locked
  // over every exposed Entity, which hash-bucketed assignment never produces and
  // a live Run leaves behind the moment it overshoots the lock, so a fixed-horizon
  // Run reported "running" with p_value 1 forever. Each arm is now truncated to
  // its first sample_size_locked Entities by exposure time.
  it("decides once both arms have reached the locked sample size", async () => {
    // One extra Entity in one arm: what a real 50/50 hash split produces.
    const offByOne = await treatmentOf(LOCKED, LOCKED + 1);
    console.log(
      `fixed @ locked+1 in one arm: status=${offByOne?.status} p=${offByOne?.p_value} ` +
        `ci=[${offByOne?.ci_lower},${offByOne?.ci_upper}]`,
    );
    // Overshooting the lock in both arms: the steady state of a live Run.
    const past = await treatmentOf(LOCKED + 160, LOCKED + 155);
    console.log(
      `fixed @ past the lock: status=${past?.status} p=${past?.p_value} ` +
        `ci=[${past?.ci_lower},${past?.ci_upper}]`,
    );

    expect(offByOne?.status).toBe("ready");
    expect(past?.status).toBe("ready");
    expect(past?.is_significant).toBe(true);
    expect(past?.sample_size_n).toBe(LOCKED);
  });

  // A fixed-horizon z-test has no peeking correction, so the answer must not
  // move as Entities keep arriving past the lock. Re-analysing later is only
  // safe because the extra Entities are excluded, not merely down-weighted.
  it("returns the same decision no matter how far past the lock the Run has run", async () => {
    const atLock = await treatmentOf(LOCKED, LOCKED);
    const wellPast = await treatmentOf(600, 590);
    console.log(
      `fixed idempotence: p=${atLock?.p_value} then p=${wellPast?.p_value} ` +
        `(n=${atLock?.sample_size_n} then ${wellPast?.sample_size_n})`,
    );
    expect(wellPast?.p_value).toBe(atLock?.p_value);
    expect(wellPast?.point_estimate).toBe(atLock?.point_estimate);
    expect(wellPast?.ci_lower).toBe(atLock?.ci_lower);
    expect(wellPast?.ci_upper).toBe(atLock?.ci_upper);
  });
});

describe("SRM checker", () => {
  it("matches a hand-computed chi-square for a balanced split", () => {
    const arms = [
      { variant: "control", values: Array.from({ length: 5000 }, () => 1) },
      { variant: "treatment", values: Array.from({ length: 4800 }, () => 1) },
    ];
    const { srm, health } = checkSrmHealth({
      run_id: RUN_ID,
      allocation: { control: 50, treatment: 50 },
      exposures: exposuresFor(arms),
    });

    // chi2 = (5000-4900)^2/4900 + (4800-4900)^2/4900 = 4.0816...
    const expectedChi2 = 100 ** 2 / 4900 + 100 ** 2 / 4900;
    const expectedP = 2 * (1 - normalCdfRef(Math.sqrt(expectedChi2)));
    console.log(
      `SRM 5000/4800: p=${srm.srm_p_value} (hand-computed ${expectedP}) mismatch=${srm.srm_is_mismatch}`,
    );
    expect(srm.srm_p_value).toBeCloseTo(expectedP, 6);
    expect(srm.srm_is_mismatch).toBe(false);
    expect(health.low_n_warning).toBe(false);
    expect(srm.expected_counts).toEqual({ control: 4900, treatment: 4900 });
  });

  it("flags a real mismatch at the 0.001 threshold", () => {
    const arms = [
      { variant: "control", values: Array.from({ length: 5000 }, () => 1) },
      { variant: "treatment", values: Array.from({ length: 4600 }, () => 1) },
    ];
    const { srm } = checkSrmHealth({
      run_id: RUN_ID,
      allocation: { control: 50, treatment: 50 },
      exposures: exposuresFor(arms),
    });
    console.log(`SRM 5000/4600: p=${srm.srm_p_value} mismatch=${srm.srm_is_mismatch}`);
    expect(srm.srm_is_mismatch).toBe(true);
  });

  it("honours an unequal declared allocation", () => {
    const arms = [
      { variant: "control", values: Array.from({ length: 9000 }, () => 1) },
      { variant: "treatment", values: Array.from({ length: 1000 }, () => 1) },
    ];
    const { srm } = checkSrmHealth({
      run_id: RUN_ID,
      allocation: { control: 90, treatment: 10 },
      exposures: exposuresFor(arms),
    });
    console.log(`SRM 90/10 split at 9000/1000: p=${srm.srm_p_value}`);
    expect(srm.srm_p_value).toBeCloseTo(1, 6);
    expect(srm.srm_is_mismatch).toBe(false);
  });
});

/** Reference standard normal CDF, Zelen & Severo 26.2.17, for the SRM check. */
function normalCdfRef(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-(x * x) / 2);
  const p =
    d *
    t *
    (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

import type { VarianceTechniques } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import {
  coverageScenarioKey,
  coverageScenarios,
  drawRelativeExperiment,
  gaussianFromUniform,
  seededUniform,
  trueRelativeLiftPct,
} from "./relative-ci-simulation-draws";
import { classifyEvaluatedLook } from "./relative-ci-simulation-look";
import type { CIResult } from "./sequential-ci";
import type { MetricArmEstimate, MetricComparisonEstimate } from "./variance-estimator-types";

const NO_TECHNIQUES: VarianceTechniques = {
  winsorized: false,
  winsorize_pct: null,
  winsorize_cap: null,
  cuped_applied: false,
  cuped_method: null,
  cuped_attribute: null,
  cuped_attribute_source: null,
  cuped_coverage_pct: null,
  delta_method: false,
};

describe("Fieller coverage gate fail-loud checks", () => {
  it("rejects a missing relative estimate when the true lift is defined", () => {
    expect(() =>
      classifyEvaluatedLook(
        { comparison: comparison({ relative_lift_pct: null }), decision: decision() },
        20,
        "fieller",
        80,
      ),
    ).toThrow(/no fieller relative interval while the true relative lift is defined/);
  });

  it("rejects a missing absolute estimate when the true lift is defined", () => {
    expect(() => classifyEvaluatedLook(null, 20, "fieller", 80)).toThrow(
      /no absolute estimate while the true relative lift is defined/,
    );
  });

  it("rejects a sequential CI error when the true lift is defined", () => {
    expect(() =>
      classifyEvaluatedLook(
        {
          comparison: comparison(),
          decision: decision({
            status: "error",
            error: {
              code: "INVALID_INPUT",
              message: "sampling_var must be finite and non-negative.",
            },
          }),
        },
        20,
        "fieller",
        80,
      ),
    ).toThrow(/sequential CI failed: sampling_var must be finite and non-negative/);
  });

  it("allows unpublished relative lift only when the true lift is undefined", () => {
    expect(
      classifyEvaluatedLook(
        { comparison: comparison({ relative_lift_pct: null }), decision: decision() },
        null,
        "fieller",
        80,
      ),
    ).toBe("undefined");
  });

  it("coverage fixtures carry positive and negative nonzero lifts for each Metric kind", () => {
    const scenarios = coverageScenarios();
    const byKind = new Map<string, number[]>();
    for (const spec of scenarios) {
      const lift = trueRelativeLiftPct(spec);
      expect(lift, coverageScenarioKey(spec)).not.toBeNull();
      expect(Math.round(lift as number), coverageScenarioKey(spec)).not.toBe(0);
      const lifts = byKind.get(spec.kind) ?? [];
      lifts.push(lift as number);
      byKind.set(spec.kind, lifts);
    }

    for (const kind of ["binomial", "count", "revenue", "ratio"] as const) {
      const lifts = byKind.get(kind);
      if (!lifts) {
        throw new Error(`expected coverage fixtures for ${kind}`);
      }
      expect(
        lifts.some((lift) => lift > 0),
        `${kind} positive lift`,
      ).toBe(true);
      expect(
        lifts.some((lift) => lift < 0),
        `${kind} negative lift`,
      ).toBe(true);
    }

    expect(scenarios.some((spec) => spec.cuped)).toBe(true);
    expect(scenarios.some((spec) => spec.kind === "ratio" && spec.cuped)).toBe(false);
  });

  it("preserves binomial arm means under CUPED with a shared-rate covariate", () => {
    const spec = {
      kind: "binomial" as const,
      controlMean: 0.25,
      treatmentMean: 0.3,
      cuped: true,
      correlation: 0.7,
    };
    const uniform = seededUniform("binomial-cuped-mean");
    const gaussian = gaussianFromUniform(uniform);
    const size = 20_000;
    const draw = drawRelativeExperiment(uniform, gaussian, spec, size);
    const controlRate = armConversionRate(draw, "control");
    const treatmentRate = armConversionRate(draw, "treatment");
    expect(Math.abs(controlRate - 0.25)).toBeLessThan(0.015);
    expect(Math.abs(treatmentRate - 0.3)).toBeLessThan(0.015);
  });
});

function armConversionRate(
  draw: ReturnType<typeof drawRelativeExperiment>,
  variant: "control" | "treatment",
): number {
  const hashes = new Set(
    draw.exposures.filter((row) => row.variant === variant).map((row) => row.targeting_key_hash),
  );
  const conversions = draw.metricValues.filter((row) => hashes.has(row.targeting_key_hash)).length;
  return conversions / hashes.size;
}

function comparison(patch: Partial<MetricComparisonEstimate> = {}): MetricComparisonEstimate {
  const control = patch.control ?? arm(10, 0.4);
  const treatment = patch.treatment ?? arm(12, 0.4);
  return {
    metric_id: "revenue",
    metric_type: "revenue",
    control,
    treatment,
    absolute_lift: (treatment.point_estimate ?? 0) - (control.point_estimate ?? 0),
    absolute_lift_sampling_var: 0.8,
    absolute_lift_var_components: {
      control: control.sampling_var ?? 0,
      treatment: treatment.sampling_var ?? 0,
    },
    relative_lift_pct: 20,
    sampling_var: 0.8,
    status: "ready",
    variance_techniques: NO_TECHNIQUES,
    ...patch,
  };
}

function arm(pointEstimate: number | null, samplingVar: number): MetricArmEstimate {
  return {
    variant: "control",
    metric_id: "revenue",
    metric_type: "revenue",
    sample_size_n: 500,
    point_estimate: pointEstimate,
    sampling_var: samplingVar,
    status: "ready",
    arm_variance: samplingVar * 500,
    denominator_mean: null,
    zero_denominator_entity_count: 0,
    delta_method: false,
    variance_techniques: NO_TECHNIQUES,
  };
}

function decision(patch: Partial<CIResult> = {}): CIResult {
  return {
    ci_lower: 0.25,
    ci_upper: 3.75,
    p_value: 0.025,
    mode: "fixed",
    status: "ok",
    source: { family: "fixed-horizon-two-sample-z-test", references: [] },
    n: 1000,
    peeking_allowed: false,
    boundary: 1.75,
    critical_value: 1.959963984540054,
    ...patch,
  };
}

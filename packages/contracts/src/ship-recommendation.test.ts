import { describe, expect, it } from "vitest";
import { evaluateExperimentDecisionGate } from "./experiment-decision-gate";
import { armResult, reachedDuration, stats } from "./experiment-decision-gate-test-fixtures";
import type { PreRegistration } from "./run-preregistration";
import { computeShipRecommendation } from "./ship-recommendation-compute";

const control = {
  state: "frozen" as const,
  variantId: "variant_control",
  variant: "control",
};

function preReg(overrides: Partial<PreRegistration> = {}): PreRegistration {
  return {
    hypothesis: "Treatment improves the primary Metric",
    primary_metric_id: "checkout-conversion",
    metrics: [
      {
        metric_id: "checkout-conversion",
        desirability: "higher_is_better",
      },
    ],
    ship_rule: {
      required_margin: 0.02,
      margin_scale: "absolute",
      conflict_resolution: "primary_wins",
    },
    ...overrides,
  };
}

function gateFor(statsOutput: ReturnType<typeof stats>) {
  return evaluateExperimentDecisionGate(statsOutput, control, reachedDuration());
}

function beneficialArm() {
  return armResult({
    absolute_ci_lower: 0.03,
    absolute_ci_upper: 0.08,
    ci_lower: 5,
    ci_upper: 15,
    relative_lift_pct: 10,
  });
}

function harmfulLowerIsBetterArm() {
  return armResult({
    absolute_ci_lower: 0.02,
    absolute_ci_upper: 0.06,
    ci_lower: 4,
    ci_upper: 12,
    relative_lift_pct: 8,
  });
}

describe("computeShipRecommendation precedence", () => {
  it("omits recommendation when there is no pre-registration", () => {
    const output = stats({ arm_results: [beneficialArm()] });
    expect(
      computeShipRecommendation({
        preRegistration: undefined,
        gate: gateFor(output),
        stats: output,
      }),
    ).toEqual({ recommendationUnavailable: "no_pre_registration" });
  });

  it("returns invalid when Exposure SRM fires", () => {
    const output = stats({
      arm_results: [beneficialArm()],
      srm: {
        ...stats().srm,
        srm_is_mismatch: true,
        srm_p_value: 0.0001,
      },
    });
    const result = computeShipRecommendation({
      preRegistration: preReg(),
      gate: gateFor(output),
      stats: output,
    });
    expect(result.recommendation?.verdict).toBe("invalid");
    expect(result.recommendation?.because).toMatch(/p =/);
    expect(result.recommendation?.because).not.toMatch(/metric_/);
  });

  it("returns keep_running when the Run is underpowered", () => {
    const output = stats({
      arm_results: [beneficialArm()],
      health: { ...stats().health, low_n_warning: true },
    });
    const result = computeShipRecommendation({
      preRegistration: preReg(),
      gate: gateFor(output),
      stats: output,
    });
    expect(result.recommendation?.verdict).toBe("keep_running");
  });

  it("returns keep_running when the primary interval has not cleared the margin", () => {
    const output = stats({
      arm_results: [
        armResult({
          absolute_ci_lower: -0.01,
          absolute_ci_upper: 0.04,
          ci_lower: -2,
          ci_upper: 8,
          relative_lift_pct: 3,
        }),
      ],
    });
    const result = computeShipRecommendation({
      preRegistration: preReg(),
      gate: gateFor(output),
      stats: output,
    });
    expect(result.recommendation).toMatchObject({
      verdict: "keep_running",
    });
    expect(result.recommendation?.because).toMatch(/has not cleared/);
  });

  it("returns do_not_ship when a lower_is_better primary shows a positive lift", () => {
    const output = stats({ arm_results: [harmfulLowerIsBetterArm()] });
    const result = computeShipRecommendation({
      preRegistration: preReg({
        metrics: [
          {
            metric_id: "checkout-conversion",
            desirability: "lower_is_better",
          },
        ],
      }),
      gate: gateFor(output),
      stats: output,
    });
    expect(result.recommendation?.verdict).toBe("do_not_ship");
    expect(result.recommendation?.because).toMatch(/positive lift/);
    expect(result.recommendation?.because).not.toMatch(/checkout-conversion/);
  });
});

describe("computeShipRecommendation ship and guardrails", () => {
  it("returns do_not_ship when any Guardrail is breached", () => {
    const output = stats({
      arm_results: [beneficialArm()],
      guardrail_results: [
        {
          metric_id: "metric_guard",
          variant: "treatment",
          ci_lower: -15.2,
          threshold: -10,
          is_breached: true,
          in_bh_family: false,
          exploratory: false,
          decision_valid: true,
          breach_reason: "relative lower bound -15.2% is below -10%",
        },
      ],
    });
    const result = computeShipRecommendation({
      preRegistration: preReg(),
      gate: gateFor(output),
      stats: output,
    });
    expect(result.recommendation?.verdict).toBe("do_not_ship");
    expect(result.recommendation?.because).toMatch(/Guardrail/);
  });

  it("returns ship when the primary clears the margin and no Guardrail is breached", () => {
    const output = stats({ arm_results: [beneficialArm()] });
    const result = computeShipRecommendation({
      preRegistration: preReg(),
      gate: gateFor(output),
      stats: output,
    });
    expect(result.recommendation?.verdict).toBe("ship");
    expect(result.recommendation?.because).toMatch(/clears the required/);
    expect(result.recommendation?.because).toMatch(/no Guardrail breach/);
  });
});

describe("computeShipRecommendation interval scales", () => {
  it("fails loud with absolute_interval_unavailable when absolute CI is missing", () => {
    const output = stats({
      arm_results: [
        armResult({
          // relative CI present; absolute omitted (pre-2.4 arm)
          ci_lower: 5,
          ci_upper: 15,
          relative_lift_pct: 10,
        }),
      ],
    });
    expect(
      computeShipRecommendation({
        preRegistration: preReg(),
        gate: gateFor(output),
        stats: output,
      }),
    ).toEqual({ recommendationUnavailable: "absolute_interval_unavailable" });
  });

  it("uses relative CI when the ship rule margin_scale is relative", () => {
    const output = stats({
      arm_results: [
        armResult({
          ci_lower: 5,
          ci_upper: 15,
          relative_lift_pct: 10,
        }),
      ],
    });
    const result = computeShipRecommendation({
      preRegistration: preReg({
        ship_rule: {
          required_margin: 0.02,
          margin_scale: "relative",
          conflict_resolution: "primary_wins",
        },
      }),
      gate: gateFor(output),
      stats: output,
    });
    expect(result.recommendation?.verdict).toBe("ship");
    expect(result.recommendation?.because).toMatch(/2%/);
  });
});

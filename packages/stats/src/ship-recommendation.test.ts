import { describe, expect, it } from "vitest";
import { armResult, stats } from "./decision-gate-test-fixtures";
import { computeShipRecommendation } from "./ship-recommendation-compute";
import {
  beneficialArm,
  breachedGuardrail,
  gateFor,
  harmfulLowerIsBetterArm,
  preReg,
  recommend,
} from "./ship-recommendation-test-fixtures";

describe("computeShipRecommendation precedence", () => {
  it("omits recommendation when there is no pre-registration", () => {
    const output = stats({ arm_results: [beneficialArm()] });
    expect(
      computeShipRecommendation({
        preRegistration: undefined,
        gate: gateFor(output),
        stats: output,
        controlVariant: "control",
        horizon: "fixed",
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
    const result = recommend(output);
    expect(result.recommendation?.verdict).toBe("invalid");
    expect(result.recommendation?.because).toMatch(/p =/);
    expect(result.recommendation?.because).not.toMatch(/metric_/);
  });

  it("returns keep_running when the Run is underpowered", () => {
    const output = stats({
      arm_results: [beneficialArm()],
      health: { ...stats().health, low_n_warning: true },
    });
    const result = recommend(output);
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
    const result = recommend(output);
    expect(result.recommendation).toMatchObject({
      verdict: "keep_running",
    });
    expect(result.recommendation?.because).toMatch(/has not cleared/);
  });

  it("returns do_not_ship when a lower_is_better primary shows a positive lift", () => {
    const output = stats({ arm_results: [harmfulLowerIsBetterArm()] });
    const result = recommend(
      output,
      preReg({
        metrics: [
          {
            metric_id: "checkout-conversion",
            desirability: "lower_is_better",
          },
        ],
      }),
    );
    expect(result.recommendation?.verdict).toBe("do_not_ship");
    expect(result.recommendation?.because).toMatch(/positive lift/);
    expect(result.recommendation?.because).not.toMatch(/checkout-conversion/);
  });
});

describe("computeShipRecommendation ship and guardrails", () => {
  it("returns do_not_ship when any Guardrail is breached", () => {
    const output = stats({
      arm_results: [beneficialArm()],
      guardrail_results: [breachedGuardrail()],
    });
    const result = recommend(output);
    expect(result.recommendation?.verdict).toBe("do_not_ship");
    expect(result.recommendation?.because).toMatch(/Guardrail/);
  });

  it("honors a known Guardrail breach before missing absolute intervals", () => {
    const output = stats({
      arm_results: [
        armResult({
          ci_lower: 5,
          ci_upper: 15,
          relative_lift_pct: 10,
        }),
      ],
      guardrail_results: [
        breachedGuardrail({
          ci_lower: -12,
          breach_reason: "relative lower bound -12% is below -10%",
        }),
      ],
    });
    const result = recommend(output);
    expect(result.recommendation?.verdict).toBe("do_not_ship");
    expect(result.recommendation?.because).toMatch(/Guardrail/);
    expect(result.recommendationUnavailable).toBeUndefined();
  });

  it("returns ship when the primary clears the margin and no Guardrail is breached", () => {
    const output = stats({ arm_results: [beneficialArm()] });
    const result = recommend(output);
    expect(result.recommendation?.verdict).toBe("ship");
    expect(result.recommendation?.because).toMatch(/clears the required/);
    expect(result.recommendation?.because).toMatch(/no Guardrail breach/);
  });
});

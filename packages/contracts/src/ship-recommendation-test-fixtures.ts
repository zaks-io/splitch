import { evaluateExperimentDecisionGate } from "./experiment-decision-gate";
import { armResult, reachedDuration } from "./experiment-decision-gate-test-fixtures";
import type { PreRegistration } from "./run-preregistration";
import { computeShipRecommendation } from "./ship-recommendation-compute";
import type { GuardrailResult, StatsOutput } from "./stats-result-contract";

const control = {
  state: "frozen" as const,
  variantId: "variant_control",
  variant: "control",
};

export function preReg(overrides: Partial<PreRegistration> = {}): PreRegistration {
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
    futility: "off",
    ...overrides,
  };
}

export function gateFor(statsOutput: StatsOutput) {
  return evaluateExperimentDecisionGate(statsOutput, control, reachedDuration());
}

export function recommend(
  statsOutput: StatsOutput,
  registration: PreRegistration = preReg(),
  horizon: "sequential" | "fixed" = "fixed",
) {
  return computeShipRecommendation({
    preRegistration: registration,
    gate: gateFor(statsOutput),
    stats: statsOutput,
    controlVariant: "control",
    horizon,
  });
}

export function beneficialArm(overrides: Parameters<typeof armResult>[0] = {}) {
  return armResult({
    absolute_ci_lower: 0.03,
    absolute_ci_upper: 0.08,
    ci_lower: 5,
    ci_upper: 15,
    relative_lift_pct: 10,
    ...overrides,
  });
}

export function harmfulLowerIsBetterArm() {
  return armResult({
    absolute_ci_lower: 0.02,
    absolute_ci_upper: 0.06,
    ci_lower: 4,
    ci_upper: 12,
    relative_lift_pct: 8,
  });
}

export function breachedGuardrail(overrides: Partial<GuardrailResult> = {}): GuardrailResult {
  return {
    metric_id: "metric_guard",
    variant: "treatment",
    ci_lower: -15.2,
    threshold: -10,
    is_breached: true,
    in_bh_family: false,
    exploratory: false,
    decision_valid: true,
    breach_reason: "relative lower bound -15.2% is below -10%",
    ...overrides,
  };
}

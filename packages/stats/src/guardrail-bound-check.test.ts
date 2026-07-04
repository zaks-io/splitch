import { describe, expect, it } from "vitest";
import type { GuardrailThreshold } from "./guardrail-bound-check";
import { applyGuardrailBoundChecks } from "./guardrail-bound-check";
import { armResult } from "./decision-family-fdr-test-helpers";

describe("applyGuardrailBoundChecks", () => {
  it("populates GuardrailResult from the relative-lift CI lower bound", () => {
    const [result] = applyGuardrailBoundChecks({
      arm_results: [guardrailArm({ ci_lower: -0.004, relative_lift_pct: -0.8 })],
      guardrails: [guardrailThreshold({ downside_threshold: -0.005 })],
    });

    expect(result).toEqual({
      metric_id: "guardrail_latency",
      variant: "treatment",
      ci_lower: -0.004,
      threshold: -0.005,
      is_breached: false,
      in_bh_family: false,
      exploratory: false,
      decision_valid: true,
      breach_reason: null,
    });
  });

  it("returns null is_breached when relative lift is undefined", () => {
    const [result] = applyGuardrailBoundChecks({
      arm_results: [guardrailArm({ ci_lower: null, relative_lift_pct: null })],
      guardrails: [guardrailThreshold()],
    });

    expect(result).toMatchObject({
      ci_lower: null,
      is_breached: null,
      breach_reason: null,
    });
  });

  it("marks decision_valid only when the Guardrail and threshold were locked at Run Start", () => {
    const [result] = applyGuardrailBoundChecks({
      arm_results: [guardrailArm()],
      guardrails: [guardrailThreshold({ threshold_locked_at_run_start: false })],
    });

    expect(result).toMatchObject({
      decision_valid: false,
      exploratory: true,
    });
  });

  it("fails loud on inconsistent relative-lift CI inputs", () => {
    expect(() =>
      applyGuardrailBoundChecks({
        arm_results: [guardrailArm({ ci_lower: null, relative_lift_pct: -1 })],
        guardrails: [guardrailThreshold()],
      }),
    ).toThrow(/relative lift is defined/);
  });
});

function guardrailArm(overrides: Parameters<typeof armResult>[3] = {}) {
  return armResult("guardrail_latency", "treatment", 0.8, {
    relative_lift_pct: -1,
    ci_lower: -0.02,
    ci_upper: 0.03,
    ...overrides,
  });
}

function guardrailThreshold(overrides: Partial<GuardrailThreshold> = {}): GuardrailThreshold {
  return {
    metric_id: "guardrail_latency",
    variant: "treatment",
    downside_threshold: -0.005,
    guardrail_locked_at_run_start: true,
    threshold_locked_at_run_start: true,
    ...overrides,
  };
}

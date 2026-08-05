import type { DecisionFamilyMember } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { applyDecisionFamilyCorrection } from "./decision-family-fdr";
import { armResult, resultKey } from "./decision-family-fdr-test-helpers";
import { applyGuardrailBoundChecks } from "./guardrail-bound-check";

describe("guardrail bound check golden fixtures", () => {
  it("fires a non-significant but breached Guardrail outside the BH family", () => {
    const decisionFamily: DecisionFamilyMember[] = [
      { metric_id: "goal_conversion", variant: "treatment" },
    ];
    const fdr = applyDecisionFamilyCorrection({
      confidence_level: 0.95,
      decision_family: decisionFamily,
      arm_results: [
        armResult("goal_conversion", "treatment", 0.2),
        armResult("guardrail_latency", "treatment", 0.8, boundCi()),
      ],
    });
    const armResultsByKey = new Map(fdr.arm_results.map((result) => [resultKey(result), result]));
    const [guardrail] = applyGuardrailBoundChecks({
      arm_results: fdr.arm_results,
      guardrails: [
        {
          metric_id: "guardrail_latency",
          variant: "treatment",
          downside_threshold_pct: -0.5,
          guardrail_locked_at_run_start: true,
          threshold_locked_at_run_start: true,
        },
      ],
    });

    expect(fdr.summary.family_size_m).toBe(1);
    expect(armResultsByKey.get("guardrail_latency/treatment")).toMatchObject({
      is_significant: false,
      in_bh_family: false,
      decision_valid: false,
    });
    expect(guardrail).toEqual({
      metric_id: "guardrail_latency",
      variant: "treatment",
      ci_lower: -2,
      threshold: -0.5,
      is_breached: true,
      in_bh_family: false,
      exploratory: false,
      decision_valid: true,
      breach_reason: "CI lower bound -2 < threshold -0.5",
    });
  });

  it("flips decision_valid when a threshold was added after Run Start", () => {
    const lockedResult = applyGuardrailBoundChecks({
      arm_results: [armResult("guardrail_latency", "treatment", 0.8, boundCi())],
      guardrails: [guardrail(true)],
    });
    const postStartThresholdResult = applyGuardrailBoundChecks({
      arm_results: [armResult("guardrail_latency", "treatment", 0.8, boundCi())],
      guardrails: [guardrail(false)],
    });

    expect(lockedResult[0]).toMatchObject({ decision_valid: true, exploratory: false });
    expect(postStartThresholdResult[0]).toMatchObject({
      decision_valid: false,
      exploratory: true,
      is_breached: true,
    });
  });
});

// Percent, like every other relative-lift field: a 1% drop whose interval runs
// from 2% worse to 0.1% better. The interval has to contain the point estimate,
// or the fixture cannot exercise the real comparison.
function boundCi() {
  return {
    relative_lift_pct: -1,
    ci_lower: -2,
    ci_upper: 0.1,
  };
}

function guardrail(thresholdLocked: boolean) {
  return {
    metric_id: "guardrail_latency",
    variant: "treatment",
    downside_threshold_pct: -0.5,
    guardrail_locked_at_run_start: true,
    threshold_locked_at_run_start: thresholdLocked,
  };
}

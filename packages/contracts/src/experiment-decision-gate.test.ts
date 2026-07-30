import { describe, expect, it } from "vitest";
import {
  evaluateExperimentDecisionGate,
  experimentSrmDiagnostics,
  srmTierFor,
} from "./experiment-decision-gate";
import type { ArmResult, StatsOutput } from "./stats-result-contract";

const varianceTechniques: ArmResult["variance_techniques"] = {
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

function armResult(overrides: Partial<ArmResult> = {}): ArmResult {
  return {
    variant: "treatment",
    metric_id: "checkout-conversion",
    sample_size_n: 4_000,
    point_estimate: 0.42,
    relative_lift_pct: 6.5,
    ci_lower: 1.2,
    ci_upper: 11.8,
    p_value: 0.004,
    is_significant: true,
    in_bh_family: true,
    exploratory: false,
    decision_valid: true,
    status: "ready",
    variance_techniques: varianceTechniques,
    ...overrides,
  };
}

function stats(overrides: Partial<StatsOutput> = {}): StatsOutput {
  return {
    arm_results: [armResult()],
    srm: {
      srm_p_value: 0.62,
      srm_is_mismatch: false,
      observed_counts: { control: 4_010, treatment: 3_990 },
      expected_counts: { control: 4_000, treatment: 4_000 },
      activated_srm_p_value: null,
      activated_srm_mismatch: null,
    },
    guardrail_results: [],
    health: {
      multiple_rate: 0,
      multiple_count: 0,
      activation_rates: null,
      activation_balance_p_value: null,
      activation_balance_mismatch: null,
      exposure_counts: { control: 4_010, treatment: 3_990 },
      deduped_counts: { control: 4_010, treatment: 3_990 },
      low_n_warning: false,
    },
    ...overrides,
  };
}

function check(output: ReturnType<typeof evaluateExperimentDecisionGate>, id: string) {
  const found = output.checks.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`gate is missing check ${id}`);
  return found;
}

describe("srmTierFor", () => {
  it("tiers the caution band separately from a confirmed mismatch", () => {
    expect(srmTierFor(0.4, false)).toBe("clean");
    expect(srmTierFor(0.011, false)).toBe("clean");
    expect(srmTierFor(0.009, false)).toBe("possible_imbalance");
    expect(srmTierFor(0.0011, false)).toBe("possible_imbalance");
    expect(srmTierFor(0.0009, false)).toBe("confirmed");
  });

  it("trusts an engine-declared mismatch over the raw p-value", () => {
    expect(srmTierFor(0.9, true)).toBe("confirmed");
  });

  it("reports clean when there is no signal to read", () => {
    expect(srmTierFor(null, null)).toBe("clean");
  });
});

describe("experimentSrmDiagnostics", () => {
  it("exposes observed-minus-expected per Variant for cause hunting", () => {
    expect(experimentSrmDiagnostics(stats()).exposure.deviations).toEqual([
      { variant: "control", observed: 4_010, expected: 4_000 },
      { variant: "treatment", observed: 3_990, expected: 4_000 },
    ]);
  });

  it("returns null activation signals when the Experiment has no activation gate", () => {
    const diagnostics = experimentSrmDiagnostics(stats());
    expect(diagnostics.activated).toBeNull();
    expect(diagnostics.activationBalance).toBeNull();
  });

  it("tiers the activated population independently of the full exposure split", () => {
    const diagnostics = experimentSrmDiagnostics(
      stats({
        srm: {
          ...stats().srm,
          activated_srm_p_value: 0.00002,
          activated_srm_mismatch: true,
        },
      }),
    );
    expect(diagnostics.exposure.tier).toBe("clean");
    expect(diagnostics.activated?.tier).toBe("confirmed");
  });
});

describe("evaluateExperimentDecisionGate", () => {
  it("allows the ship decision when every applicable check passes", () => {
    const gate = evaluateExperimentDecisionGate(stats());
    expect(gate.shipAllowed).toBe(true);
    expect(gate.blockedBy).toEqual([]);
    expect(gate.enforcedBy).toBe("control-plane-api");
  });

  it("blocks and cites the exposure SRM check when SRM is firing", () => {
    const gate = evaluateExperimentDecisionGate(
      stats({
        srm: {
          srm_p_value: 0.0000001,
          srm_is_mismatch: true,
          observed_counts: { control: 7_600, treatment: 400 },
          expected_counts: { control: 4_000, treatment: 4_000 },
          activated_srm_p_value: null,
          activated_srm_mismatch: null,
        },
      }),
    );
    expect(gate.shipAllowed).toBe(false);
    expect(gate.blockedBy).toEqual(["exposure_srm"]);
    expect(check(gate, "exposure_srm").title).toBe("Sample Ratio Mismatch is firing");
  });

  it("blocks on the caution band without calling it a confirmed mismatch", () => {
    const gate = evaluateExperimentDecisionGate(
      stats({ srm: { ...stats().srm, srm_p_value: 0.004 } }),
    );
    expect(gate.shipAllowed).toBe(false);
    expect(check(gate, "exposure_srm").title).toBe("Possible exposure imbalance");
  });

  it("blocks and names the starved Metric when the result is underpowered", () => {
    const gate = evaluateExperimentDecisionGate(
      stats({ arm_results: [armResult({ status: "insufficient_n" })] }),
    );
    expect(gate.blockedBy).toEqual(["underpowered"]);
    expect(check(gate, "underpowered").detail).toContain("checkout-conversion / treatment");
  });

  it("blocks on a low-n warning even when no arm reports a starved status", () => {
    const gate = evaluateExperimentDecisionGate(
      stats({ health: { ...stats().health, low_n_warning: true } }),
    );
    expect(gate.blockedBy).toEqual(["underpowered"]);
  });

  // "Large enough to decide" would be a claim about zero Metrics.
  it("does not claim a sample-size pass when there is no decision-valid result to size", () => {
    const gate = evaluateExperimentDecisionGate(stats({ arm_results: [] }));

    expect(check(gate, "underpowered").status).toBe("not_applicable");
    expect(check(gate, "underpowered").detail).not.toContain("enough");
    expect(gate.shipAllowed).toBe(false);
    expect(gate.blockedBy).toEqual(["decision_valid_result"]);
  });

  it("blocks when the Run has no FDR-corrected decision-valid result", () => {
    const gate = evaluateExperimentDecisionGate(
      stats({ arm_results: [armResult({ in_bh_family: false, exploratory: true })] }),
    );
    expect(gate.blockedBy).toEqual(["decision_valid_result"]);
  });

  it("blocks on both activation guardrails for a gated Experiment", () => {
    const base = stats();
    const gate = evaluateExperimentDecisionGate(
      stats({
        srm: { ...base.srm, activated_srm_p_value: 0.00001, activated_srm_mismatch: true },
        health: {
          ...base.health,
          activation_rates: { control: 0.81, treatment: 0.42 },
          activation_balance_p_value: 0.000004,
          activation_balance_mismatch: true,
        },
      }),
    );
    expect(gate.blockedBy).toEqual(["activated_srm", "activation_balance"]);
  });

  it("cites every failing check rather than stopping at the first", () => {
    const base = stats();
    const gate = evaluateExperimentDecisionGate(
      stats({
        srm: { ...base.srm, srm_p_value: 0.0000001, srm_is_mismatch: true },
        arm_results: [armResult({ status: "insufficient_n" })],
      }),
    );
    expect(gate.blockedBy).toEqual(["exposure_srm", "underpowered"]);
  });

  it("marks activation checks not applicable rather than passing them on no evidence", () => {
    const gate = evaluateExperimentDecisionGate(stats());
    expect(check(gate, "activated_srm").status).toBe("not_applicable");
    expect(check(gate, "activation_balance").status).toBe("not_applicable");
  });

  it("never lets a Guardrail breach alone block the decision", () => {
    const gate = evaluateExperimentDecisionGate(
      stats({
        guardrail_results: [
          {
            metric_id: "checkout-reliability",
            variant: "treatment",
            ci_lower: -28.4,
            threshold: -10,
            is_breached: true,
            in_bh_family: false,
            exploratory: false,
            decision_valid: true,
            breach_reason: "CI lower bound is below the locked downside threshold",
          },
        ],
      }),
    );
    expect(gate.shipAllowed).toBe(true);
  });
});

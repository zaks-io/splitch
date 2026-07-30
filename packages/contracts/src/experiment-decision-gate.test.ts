import { describe, expect, it } from "vitest";
import {
  evaluateExperimentDecisionGate,
  experimentSrmDiagnostics,
  srmTierFor,
} from "./experiment-decision-gate";
import { armResult, check, stats } from "./experiment-decision-gate-test-fixtures";
import type { ArmResult } from "./stats-result-contract";

describe("srmTierFor", () => {
  it("tiers the caution band separately from a confirmed mismatch", () => {
    expect(srmTierFor(0.4, false)).toBe("clean");
    expect(srmTierFor(0.011, false)).toBe("clean");
    expect(srmTierFor(0.009, false)).toBe("possible_imbalance");
    expect(srmTierFor(0.0011, false)).toBe("possible_imbalance");
  });

  it("trusts an engine-declared mismatch over the raw p-value", () => {
    expect(srmTierFor(0.9, true)).toBe("confirmed");
  });

  it("falls back to the threshold only when the engine declared no verdict", () => {
    expect(srmTierFor(0.0009, null)).toBe("confirmed");
  });

  // The tier a surface renders and the verdict the gate enforces have to come
  // from the same authority, or the page condemns a Run the gate will ship.
  it("does not call a mismatch the engine denied confirmed, and agrees with the gate", () => {
    expect(srmTierFor(0.0009, false)).toBe("possible_imbalance");

    const gate = evaluateExperimentDecisionGate(
      stats({ srm: { ...stats().srm, srm_p_value: 0.0009, srm_is_mismatch: false } }),
    );
    expect(gate.blockedBy).not.toContain("exposure_srm");
    expect(check(gate, "exposure_srm").status).toBe("pass");
  });

  it("reports clean when there is no signal to read", () => {
    expect(srmTierFor(null, null)).toBe("clean");
  });
});

describe("experimentSrmDiagnostics", () => {
  it("exposes observed-minus-expected per Variant for cause hunting", () => {
    expect(experimentSrmDiagnostics(stats()).exposure.deviations).toEqual([
      { variant: "control", observed: 4_010, expected: 4_000, delta: 10 },
      { variant: "treatment", observed: 3_990, expected: 4_000, delta: -10 },
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

// BH correction spans top-level goal Metrics and Primary Dimension slices

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

  // The spec blocks a firing SRM. The caution band warns, and blocking on it
  // would hold a stricter bar than the stats engine itself does.
  it("warns on the caution band without blocking the decision", () => {
    const gate = evaluateExperimentDecisionGate(
      stats({ srm: { ...stats().srm, srm_p_value: 0.004, srm_is_mismatch: false } }),
    );
    expect(gate.shipAllowed).toBe(true);
    expect(check(gate, "exposure_srm").status).toBe("pass");
    expect(check(gate, "exposure_srm").detail).toContain("caution band");
  });

  // The engine's verdict is the authority, not a threshold re-applied here.
  it("blocks whenever the engine says SRM is firing, whatever the p-value reads", () => {
    const gate = evaluateExperimentDecisionGate(
      stats({ srm: { ...stats().srm, srm_p_value: 0.004, srm_is_mismatch: true } }),
    );
    expect(gate.blockedBy).toEqual(["exposure_srm"]);
  });

  it("does not block on either side of the caution boundary when the engine reports no mismatch", () => {
    for (const srmP of [0.0011, 0.009, 0.011]) {
      const gate = evaluateExperimentDecisionGate(
        stats({ srm: { ...stats().srm, srm_p_value: srmP, srm_is_mismatch: false } }),
      );
      expect(gate.blockedBy).toEqual([]);
    }
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

describe("evaluateExperimentDecisionGate readiness", () => {
  it("blocks and names the starved Metric when the result is underpowered", () => {
    const gate = evaluateExperimentDecisionGate(
      stats({ arm_results: [armResult({ status: "insufficient_n" })] }),
    );
    expect(gate.blockedBy).toEqual(["underpowered"]);
    expect(check(gate, "underpowered").detail).toContain("checkout-conversion / treatment");
  });

  /**
   * The engine encodes a fixed-horizon Run below its locked sample size as
   * `running`, not as a shortfall status (packages/stats metric-arm-results).
   * A gate that only recognized the shortfall statuses would call this Run
   * shippable while it is still collecting.
   */
  it("refuses a fixed-horizon Run that is still collecting, which the engine reports as running", () => {
    const gate = evaluateExperimentDecisionGate(
      stats({ arm_results: [armResult({ status: "running" })] }),
    );
    expect(gate.shipAllowed).toBe(false);
    expect(gate.blockedBy).toEqual(["underpowered"]);
    expect(check(gate, "underpowered").title).toBe("Run has not reached its locked sample size");
  });

  it("refuses an estimator error rather than reporting it as a sample-size problem", () => {
    const gate = evaluateExperimentDecisionGate(
      stats({ arm_results: [armResult({ status: "error" })] }),
    );
    expect(gate.shipAllowed).toBe(false);
    expect(gate.blockedBy).toEqual(["engine_status"]);
    expect(check(gate, "engine_status").detail).toContain("checkout-conversion / treatment");
  });

  it("refuses a starved denominator, which the engine reports separately from insufficient_n", () => {
    const gate = evaluateExperimentDecisionGate(
      stats({ arm_results: [armResult({ status: "insufficient_denominator" })] }),
    );
    expect(gate.blockedBy).toEqual(["underpowered"]);
  });

  // Every status the engine can emit must land somewhere explicit. Only the two
  // decidable ones may ship; anything else is a refusal.
  it("allows a decision on exactly the decidable engine statuses", () => {
    const shippable = new Map<ArmResult["status"], boolean>([
      ["ready", true],
      ["stopped", true],
      ["running", false],
      ["insufficient_n", false],
      ["insufficient_denominator", false],
      ["error", false],
    ]);
    for (const [status, expected] of shippable) {
      const gate = evaluateExperimentDecisionGate(stats({ arm_results: [armResult({ status })] }));
      expect(gate.shipAllowed, `status ${status}`).toBe(expected);
    }
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
});

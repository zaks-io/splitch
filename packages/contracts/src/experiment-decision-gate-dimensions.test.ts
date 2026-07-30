import { describe, expect, it } from "vitest";
import { armResult, check, gateFor, stats } from "./experiment-decision-gate-test-fixtures";
import type { DimensionResult } from "./stats-result-contract";

// (docs/spec/stats/dimension-slicing.md), so readiness has to read both.
describe("evaluateExperimentDecisionGate dimension slices", () => {
  function dimension(overrides: Partial<DimensionResult> = {}): DimensionResult {
    return {
      dimension_id: "country",
      dimension_value: "US",
      class: "primary",
      arm_results: [armResult()],
      sample_size_n: 2_000,
      low_n_warning: false,
      in_bh_family: true,
      exploratory: false,
      decision_valid: true,
      ...overrides,
    };
  }

  it("allows a decision carried entirely by a Primary Dimension slice", () => {
    const gate = gateFor(stats({ arm_results: [], dimension_results: [dimension()] }));
    expect(gate.shipAllowed).toBe(true);
    expect(check(gate, "decision_valid_result").status).toBe("pass");
  });

  it("refuses to ignore an estimator failure inside a Primary Dimension slice", () => {
    const gate = gateFor(
      stats({ dimension_results: [dimension({ arm_results: [armResult({ status: "error" })] })] }),
    );
    expect(gate.shipAllowed).toBe(false);
    expect(gate.blockedBy).toContain("engine_status");
    // The refusal has to name the slice, not just the Metric it shares with the
    // top-level result that is doing fine.
    expect(check(gate, "engine_status").detail).toContain("[country=US]");
  });

  it("leaves a Secondary Dimension out of the decision family entirely", () => {
    const gate = gateFor(
      stats({
        arm_results: [],
        dimension_results: [
          dimension({ class: "secondary", arm_results: [armResult({ status: "error" })] }),
        ],
      }),
    );
    expect(gate.blockedBy).not.toContain("engine_status");
    expect(check(gate, "decision_valid_result").status).toBe("fail");
  });
});

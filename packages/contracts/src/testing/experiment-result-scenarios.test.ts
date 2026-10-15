import { describe, expect, it } from "vitest";
import { cleanScenario, controlDisagreementScenario } from "./experiment-result-scenarios";

describe("Experiment Results scenario builders", () => {
  it("rejects invalid stats, control, gate and SRM overrides", () => {
    const base = cleanScenario();
    const arm = base.stats.arm_results[0];
    if (!arm) throw new Error("Clean scenario requires a Treatment result");
    expect(() =>
      cleanScenario({
        stats: {
          ...base.stats,
          arm_results: [{ ...arm, sample_size_n: Number.NaN }],
        },
      }),
    ).toThrow();
    expect(() =>
      cleanScenario({ control: { state: "frozen", variantId: "", variant: "control" } }),
    ).toThrow();
    expect(() =>
      cleanScenario({ gate: { ...base.gate, enforcedBy: "browser" as "control-plane-api" } }),
    ).toThrow();
    expect(() =>
      cleanScenario({
        srm: { ...base.srm, exposure: { ...base.srm.exposure, pValue: Number.NaN } },
      }),
    ).toThrow();
  });

  it("replaces nested overrides explicitly and returns independent copies", () => {
    const stats = cleanScenario().stats;
    stats.guardrail_results = [];
    expect(cleanScenario({ stats }).stats.guardrail_results).toEqual([]);
    const first = controlDisagreementScenario();
    first.stats.arm_results.length = 0;
    first.gate.checks.length = 0;
    first.srm.exposure.deviations.length = 0;
    first.control.variantId = "changed";
    const second = controlDisagreementScenario();
    expect(second.stats.arm_results).toHaveLength(2);
    expect(second.gate.checks).toHaveLength(8);
    expect(second.srm.exposure.deviations).toHaveLength(2);
    expect(second.control.variantId).toBe("variant_control");
  });
});

import type { PanelExperimentRun } from "@splitch/control-plane-sdk/panel-experiments";
import { describe, expect, it } from "vitest";
import { describeRunChange } from "./experiment-run-diff";

describe("describeRunChange", () => {
  it("describes the first Run without inventing a prior snapshot", () => {
    expect(describeRunChange(run(), undefined)).toBe("Experiment started");
  });

  it("derives allocation changes from consecutive frozen snapshots", () => {
    expect(
      describeRunChange(
        run({ runNumber: 2, allocation: { control: 70, treatment: 30 } }),
        run({ allocation: { control: 50, treatment: 50 } }),
      ),
    ).toBe("Allocation 50%/50% → 70%/30%");
  });

  it("surfaces Variant, Targeting Key, Targeting, and salt changes", () => {
    const previous = run();
    const current = run({
      runNumber: 2,
      targetingKey: "accountId",
      salt: "salt-2",
      allocation: { control: 40, treatment: 40, holdout: 20 },
      variantsJson: JSON.stringify([
        { id: "variant_control", name: "control", value: false },
        { id: "variant_treatment", name: "treatment", value: "new-value" },
        { id: "variant_holdout", name: "holdout", value: "holdout" },
      ]),
      targetingRulesJson: JSON.stringify([
        {
          id: "rule_1",
          flagId: "flag_1",
          priority: 0,
          conditions: [{ attribute: "country", operator: "eq", value: "US" }],
          variantId: "variant_treatment",
        },
      ]),
    });

    expect(describeRunChange(current, previous)).toContain("Added Variant `holdout`");
    expect(describeRunChange(current, previous)).toContain("Changed Variant `treatment`");
    expect(describeRunChange(current, previous)).toContain("Targeting Key userId → accountId");
    expect(describeRunChange(current, previous)).toContain("Targeting changed");
    expect(describeRunChange(current, previous)).toContain("Assignment salt changed");
  });
});

function run(overrides: Partial<PanelExperimentRun> = {}): PanelExperimentRun {
  return {
    id: "run_1",
    experimentId: "experiment_1",
    environmentId: "env_1",
    runNumber: 1,
    status: "ended",
    targetingKey: "userId",
    targetingKeyType: "user",
    salt: "salt-1",
    allocation: { control: 50, treatment: 50 },
    controlVariantId: "variant_control",
    variantsJson: JSON.stringify([
      { id: "variant_control", name: "control", value: false },
      { id: "variant_treatment", name: "treatment", value: true },
    ]),
    targetingRulesJson: "[]",
    configHash: "sha256:one",
    startedAt: "2026-07-18T00:00:00.000Z",
    endedAt: "2026-07-19T00:00:00.000Z",
    startReason: null,
    endReason: null,
    createdAt: "2026-07-18T00:00:00.000Z",
    ...overrides,
  };
}

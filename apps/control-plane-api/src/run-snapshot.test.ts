import { describe, expect, it } from "vitest";
import type { RunRow } from "./experiment-model";
import { runSnapshotRow } from "./run-snapshot";

const scope = { appId: "app_1", environmentId: "env_prod" };

describe("runSnapshotRow", () => {
  it("maps frozen Run values and resolves the Control Variant name", () => {
    expect(runSnapshotRow(run(), scope, "2026-08-03T12:00:00.100Z")).toEqual({
      app_id: "app_1",
      environment_id: "env_prod",
      experiment_id: "exp_1",
      run_id: "run_1",
      started_at: "2026-08-03T12:00:00.000Z",
      snapshot_at: "2026-08-03T12:00:00.100Z",
      confidence_level: 0.95,
      horizon: "sequential",
      target_n: null,
      sample_size_locked: 2000,
      allocation: '{"control":40,"treatment":60}',
      control_variant: "control",
      control_variant_id: "variant_control",
      decision_family: '[{"metricId":"metric_1"}]',
      guardrail_decisions: "[]",
      dimensions: "[]",
      config_hash: "sha256:run-1",
    });
  });

  it("throws when the frozen Control Variant is absent", () => {
    expect(() =>
      runSnapshotRow(run({ controlVariantId: "variant_missing" }), scope, "now"),
    ).toThrow("is absent from variantSet");
  });

  it("throws when variantSet is unparseable", () => {
    expect(() => runSnapshotRow(run({ variantSet: "not-json" }), scope, "now")).toThrow(
      "variantSet is unparseable",
    );
  });
});

function run(overrides: Partial<RunRow> = {}): RunRow {
  return {
    id: "run_1",
    appId: "app_1",
    environmentId: "env_prod",
    experimentId: "exp_1",
    runNumber: 1,
    status: "running",
    targetingKeyField: "userId",
    targetingKeyType: "user",
    activationMetricId: null,
    salt: "salt",
    allocation: '{"control":40,"treatment":60}',
    variantSet:
      '[{"id":"variant_control","name":"control"},{"id":"variant_treatment","name":"treatment"}]',
    controlVariantId: "variant_control",
    targetingRules: "[]",
    confidenceLevel: 0.95,
    horizon: "sequential",
    targetN: null,
    sampleSizeLocked: 2000,
    decisionFamily: '[{"metricId":"metric_1"}]',
    guardrailDecisions: "[]",
    configHash: "sha256:run-1",
    startedAt: "2026-08-03T12:00:00.000Z",
    endedAt: null,
    startReason: null,
    endReason: null,
    createdAt: "2026-08-03T12:00:00.000Z",
    createdBy: "user_1",
    ...overrides,
  };
}

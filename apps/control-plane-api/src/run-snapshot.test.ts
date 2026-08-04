import { describe, expect, it, vi } from "vitest";
import type { RunRow } from "./experiment-model";
import { runSnapshotRow, shipCommittedRunSnapshot } from "./run-snapshot";

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
      decision_family: '[{"metric_id":"metric_1","variant":"treatment"}]',
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

  it("expands D1 MetricRef decision_family into Stats DecisionFamilyMember[]", () => {
    const row = runSnapshotRow(
      run({ decisionFamily: '[{"metricId":"metric_a"},{"metricId":"metric_b"}]' }),
      scope,
      "now",
    );
    expect(JSON.parse(row.decision_family)).toEqual([
      { metric_id: "metric_a", variant: "treatment" },
      { metric_id: "metric_b", variant: "treatment" },
    ]);
  });

  it("drops MetricRef guardrail_decisions rather than inventing thresholds", () => {
    const row = runSnapshotRow(
      run({ guardrailDecisions: '[{"metricId":"metric_guard"}]' }),
      scope,
      "now",
    );
    expect(row.guardrail_decisions).toBe("[]");
  });

  it("throws when variantSet is unparseable", () => {
    expect(() => runSnapshotRow(run({ variantSet: "not-json" }), scope, "now")).toThrow(
      "variantSet is unparseable",
    );
  });
});

describe("shipCommittedRunSnapshot faults", () => {
  const delivery = (overrides: Record<string, unknown>) => ({
    apiUrl: "https://tinybird.local",
    token: "token",
    ...overrides,
  });

  it("routes a ship failure to onFault with the Run identifiers", async () => {
    const onFault = vi.fn();
    const shipped = await shipCommittedRunSnapshot(
      delivery({ fetch: () => Promise.reject(new Error("boom")), onFault }),
      run(),
      scope,
      "now",
    );
    expect(shipped).toBe(false);
    expect(onFault).toHaveBeenCalledOnce();
    const [detail] = onFault.mock.calls[0] ?? [];
    expect(detail).toMatchObject({
      appId: "app_1",
      environmentId: "env_prod",
      experimentId: "exp_1",
      runId: "run_1",
    });
  });

  it("does not call onFault on success", async () => {
    const onFault = vi.fn();
    const shipped = await shipCommittedRunSnapshot(
      delivery({
        fetch: () => Promise.resolve(Response.json({ successful_rows: 1, quarantined_rows: 0 })),
        onFault,
      }),
      run(),
      scope,
      "now",
    );
    expect(shipped).toBe(true);
    expect(onFault).not.toHaveBeenCalled();
  });

  it("treats a 2xx that quarantined the row as a ship failure", async () => {
    const onFault = vi.fn();
    const shipped = await shipCommittedRunSnapshot(
      delivery({
        fetch: () => Promise.resolve(Response.json({ successful_rows: 0, quarantined_rows: 1 })),
        onFault,
      }),
      run(),
      scope,
      "now",
    );
    expect(shipped).toBe(false);
    expect(onFault.mock.calls[0]?.[0]).toMatchObject({
      fault: expect.stringContaining("quarantined"),
    });
  });

  it("a throwing fault sink still reports the ship as failed", async () => {
    const shipped = await shipCommittedRunSnapshot(
      delivery({
        fetch: () => Promise.reject(new Error("boom")),
        onFault: () => {
          throw new Error("sink down");
        },
      }),
      run(),
      scope,
      "now",
    );
    expect(shipped).toBe(false);
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

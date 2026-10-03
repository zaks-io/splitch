import { describe, expect, it } from "vitest";
import {
  ExperimentUpdateResponseSchema,
  StartRunResponseSchema,
} from "./resource-envelopes-experiment";

const variantControl = { id: "var_1", name: "control", value: false };
const variantTreatment = { id: "var_2", name: "treatment", value: "on" };

const preRegistration = {
  hypothesis: "Treatment raises signup rate",
  primaryMetricId: "metric_goal",
  metrics: [{ metricId: "metric_goal", desirability: "higher_is_better" as const }],
  shipRule: {
    requiredMargin: 0.02,
    marginScale: "absolute" as const,
    conflictResolution: "primary_wins" as const,
  },
};

describe("StartRunResponseSchema (SPL-307 frozen targeting)", () => {
  it("requires frozenTargetingRules alongside the Run", () => {
    const run = {
      id: "run_1",
      experimentId: "exp_1",
      environmentId: "env_prod",
      status: "running" as const,
      targetingKeyType: "user",
      salt: "salt-1",
      allocation: { control: 50, treatment: 50 },
      variantSet: [variantControl, variantTreatment],
      targetingRules: [],
      configHash: "hash-1",
      startedAt: "2026-06-28T00:00:00.000Z",
      endedAt: null,
      createdAt: "2026-06-28T00:00:00.000Z",
    };
    expect(
      StartRunResponseSchema.safeParse({
        experimentId: "exp_1",
        run,
        previousRunId: null,
        approvalRequest: null,
      }).success,
    ).toBe(false);
    const parsed = StartRunResponseSchema.parse({
      experimentId: "exp_1",
      run,
      previousRunId: null,
      approvalRequest: null,
      frozenTargetingRules: [],
    });
    expect(parsed.frozenTargetingRules).toEqual([]);
  });

  it("keeps frozen preRegistration on the Start Run leaf", () => {
    const parsed = StartRunResponseSchema.parse({
      experimentId: "exp_1",
      run: {
        id: "run_1",
        experimentId: "exp_1",
        environmentId: "env_prod",
        status: "running",
        targetingKeyType: "user",
        salt: "salt-1",
        allocation: { control: 50, treatment: 50 },
        variantSet: [variantControl, variantTreatment],
        targetingRules: [],
        configHash: "hash-1",
        startedAt: "2026-06-28T00:00:00.000Z",
        endedAt: null,
        createdAt: "2026-06-28T00:00:00.000Z",
        preRegistration,
      },
      previousRunId: null,
      approvalRequest: null,
      frozenTargetingRules: [],
    });
    expect(parsed.run.preRegistration).toEqual(preRegistration);
  });
});

describe("ExperimentUpdateResponseSchema (SPL-307 liveRunUnaffected)", () => {
  it("parses an optional liveRunUnaffected notice on a staged edit", () => {
    const experiment = {
      id: "exp_1",
      appId: "app_1",
      environmentId: "env_prod",
      key: "checkout-test",
      flagId: "flag_1",
      name: "Checkout test",
      status: "running" as const,
      targetingKey: "userId",
      targetingKeyType: "user",
      confidenceLevel: 0.95,
      defaultVariantId: "var_1",
      metrics: [],
      guardrailMetrics: [],
      conversionWindowMs: 0,
      dimensions: [],
      liveRunId: "run_1",
      createdAt: "2026-06-28T00:00:00.000Z",
      updatedAt: "2026-06-28T00:00:00.000Z",
    };
    const parsed = ExperimentUpdateResponseSchema.parse({
      ...experiment,
      liveRunUnaffected: { runId: "run_1", frozenTargetingRules: [] },
    });
    expect(parsed.liveRunUnaffected?.runId).toBe("run_1");
  });
});

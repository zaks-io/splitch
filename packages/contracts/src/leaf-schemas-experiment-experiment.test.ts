import { describe, expect, it } from "vitest";
import {
  ExperimentSchema,
  ExperimentStatusSchema,
  experimentStatuses,
} from "./leaf-schemas-experiment.js";

const validExperiment = {
  id: "exp_1",
  appId: "app_1",
  environmentId: "env_prod",
  key: "checkout-redesign",
  flagId: "flag_1",
  name: "Checkout Redesign",
  status: "draft" as const,
  targetingKey: "userId",
  targetingKeyType: "user",
  confidenceLevel: 0.95,
  defaultVariantId: "var_1",
  metrics: [{ metricId: "metric_goal" }],
  guardrailMetrics: [{ metricId: "metric_guard" }],
  conversionWindowMs: 86_400_000,
  dimensions: ["country", "plan"],
  liveRunId: null,
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-02T00:00:00Z",
};

describe("ExperimentStatusSchema", () => {
  it("accepts every declared status", () => {
    for (const s of experimentStatuses) {
      expect(ExperimentStatusSchema.safeParse(s).success).toBe(true);
    }
  });

  it("rejects a value outside the enum", () => {
    expect(ExperimentStatusSchema.safeParse("paused").success).toBe(false);
    expect(ExperimentStatusSchema.safeParse("archived").success).toBe(false);
    expect(ExperimentStatusSchema.safeParse("").success).toBe(false);
  });
});

describe("ExperimentSchema", () => {
  it("parses a full valid experiment", () => {
    const e = ExperimentSchema.parse(validExperiment);
    expect(e.id).toBe("exp_1");
    expect(e.flagId).toBe("flag_1");
    expect(e.targetingKey).toBe("userId");
    expect(e.targetingKeyType).toBe("user");
    expect(e.liveRunId).toBeNull();
    expect(e.metrics).toHaveLength(1);
  });

  it("flagId is a single string (one Experiment controls one Flag)", () => {
    const e = ExperimentSchema.parse(validExperiment);
    expect(typeof e.flagId).toBe("string");
  });

  it("accepts a non-null liveRunId when running", () => {
    const e = ExperimentSchema.parse({
      ...validExperiment,
      status: "running",
      liveRunId: "run_1",
    });
    expect(e.liveRunId).toBe("run_1");
  });

  it("rejects a missing liveRunId (required, but nullable)", () => {
    const { liveRunId: _, ...rest } = validExperiment;
    expect(ExperimentSchema.safeParse(rest).success).toBe(false);
  });

  it("accepts a null activationMetricId", () => {
    const e = ExperimentSchema.parse({ ...validExperiment, activationMetricId: null });
    expect(e.activationMetricId).toBeNull();
  });

  it("accepts a set activationMetricId", () => {
    const e = ExperimentSchema.parse({ ...validExperiment, activationMetricId: "metric_gate" });
    expect(e.activationMetricId).toBe("metric_gate");
  });

  it("accepts optional description and hypothesis", () => {
    const e = ExperimentSchema.parse({
      ...validExperiment,
      description: "Test new flow",
      hypothesis: "Conversion improves by 5%",
    });
    expect(e.hypothesis).toBe("Conversion improves by 5%");
  });

  it("accepts empty metrics and guardrailMetrics arrays", () => {
    const e = ExperimentSchema.parse({ ...validExperiment, metrics: [], guardrailMetrics: [] });
    expect(e.metrics).toHaveLength(0);
  });

  it("rejects a status outside the enum", () => {
    expect(ExperimentSchema.safeParse({ ...validExperiment, status: "paused" }).success).toBe(
      false,
    );
  });

  it("rejects a non-numeric confidenceLevel", () => {
    expect(
      ExperimentSchema.safeParse({ ...validExperiment, confidenceLevel: "0.95" }).success,
    ).toBe(false);
  });

  it("rejects a malformed MetricRef in metrics", () => {
    expect(
      ExperimentSchema.safeParse({ ...validExperiment, metrics: [{ id: "metric_goal" }] }).success,
    ).toBe(false);
  });

  it("rejects missing required targetingKey", () => {
    const { targetingKey: _, ...rest } = validExperiment;
    expect(ExperimentSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects missing required environmentId", () => {
    const { environmentId: _, ...rest } = validExperiment;
    expect(ExperimentSchema.safeParse(rest).success).toBe(false);
  });
});

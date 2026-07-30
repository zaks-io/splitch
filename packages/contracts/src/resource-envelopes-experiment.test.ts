import { describe, expect, it } from "vitest";
import {
  CreateExperimentRequestSchema,
  ExperimentResponseSchema,
  PatchExperimentRequestSchema,
  PatchRunRequestSchema,
  RunResponseSchema,
  StartRunRequestSchema,
} from "./resource-envelopes-experiment";

const validCreateExperiment = {
  appId: "app_1",
  environmentId: "env_prod",
  name: "Checkout test",
  key: "checkout-test",
  flagId: "flag_1",
  targetingKey: "userId",
  targetingKeyType: "user",
  metrics: [{ metricId: "m_1" }],
};

describe("CreateExperimentRequestSchema (defaultVariantId is Worker-copied)", () => {
  it("PARSES WITHOUT defaultVariantId and applies field defaults", () => {
    const req = CreateExperimentRequestSchema.parse(validCreateExperiment);
    expect(req.confidenceLevel).toBe(0.95);
    expect(req.guardrailMetrics).toEqual([]);
    expect(req.conversionWindowMs).toBe(0);
    expect(req.dimensions).toEqual([]);
    expect("defaultVariantId" in req).toBe(false);
  });

  it("parses with empty metrics (min 0)", () => {
    expect(
      CreateExperimentRequestSchema.safeParse({ ...validCreateExperiment, metrics: [] }).success,
    ).toBe(true);
  });

  it("accepts an optional idempotency_key", () => {
    const req = CreateExperimentRequestSchema.parse({
      ...validCreateExperiment,
      idempotency_key: "idem-1",
    });
    expect(req.idempotency_key).toBe("idem-1");
  });

  it("parses staged draft assignment fields without enforcing Start invariants", () => {
    const req = CreateExperimentRequestSchema.parse({
      ...validCreateExperiment,
      allocation: { control: 60, treatment: 30 },
      salt: "draft-salt",
      targetingRules: [],
      segmentIds: ["seg_1"],
    });
    expect(req.allocation).toEqual({ control: 60, treatment: 30 });
    expect(req.segmentIds).toEqual(["seg_1"]);
  });

  it("rejects a missing targetingKey", () => {
    const { targetingKey, ...noKey } = validCreateExperiment;
    void targetingKey;
    expect(CreateExperimentRequestSchema.safeParse(noKey).success).toBe(false);
  });
});

describe("PatchExperimentRequestSchema", () => {
  it("parses a measurement-edit patch", () => {
    const req = PatchExperimentRequestSchema.parse({ conversionWindowMs: 86_400_000 });
    expect(req.conversionWindowMs).toBe(86_400_000);
  });

  it("parses assignment draft edits for Worker taxonomy enforcement", () => {
    const req = PatchExperimentRequestSchema.parse({
      stageForNextRun: true,
      allocation: { control: 50, treatment: 50 },
      salt: "next-salt",
      variantSet: [variantControl, variantTreatment],
      targetingRules: [],
      segmentIds: ["seg_1"],
      flagId: "flag_2",
      activationMetricId: "metric_activation",
    });
    expect(req.salt).toBe("next-salt");
    expect(req.stageForNextRun).toBe(true);
    expect(req.variantSet).toHaveLength(2);
  });

  it("rejects status patches because Run end owns lifecycle transitions", () => {
    expect(PatchExperimentRequestSchema.safeParse({ status: "ended" }).success).toBe(false);
    expect(PatchExperimentRequestSchema.safeParse({ status: "running" }).success).toBe(false);
  });

  it("rejects an unknown field (strict)", () => {
    expect(PatchExperimentRequestSchema.safeParse({ liveRunId: "run_1" }).success).toBe(false);
  });
});

describe("ExperimentResponseSchema", () => {
  it("parses the full Experiment leaf", () => {
    const res = ExperimentResponseSchema.parse({
      id: "exp_1",
      appId: "app_1",
      environmentId: "env_prod",
      key: "checkout-test",
      flagId: "flag_1",
      name: "Checkout test",
      owner: "user_1",
      tags: ["checkout", "q3"],
      status: "draft",
      targetingKey: "userId",
      targetingKeyType: "user",
      activationMetricId: null,
      confidenceLevel: 0.95,
      defaultVariantId: "var_1",
      metrics: [{ metricId: "m_1" }],
      guardrailMetrics: [],
      conversionWindowMs: 0,
      dimensions: [],
      draftAllocation: { control: 50, treatment: 50 },
      draftSalt: "draft-salt",
      draftTargetingRules: [],
      draftSegmentIds: ["seg_1"],
      liveRunId: null,
      createdAt: "2026-06-28T00:00:00.000Z",
      updatedAt: "2026-06-28T00:00:00.000Z",
    });
    expect(res.liveRunId).toBeNull();
  });
});

const variantControl = { id: "var_1", name: "control", value: false };
const variantTreatment = { id: "var_2", name: "treatment", value: "on" };

describe("StartRunRequestSchema (the only path to open a Run)", () => {
  it("requires an idempotency key and accepts an optional inline review", () => {
    const req = StartRunRequestSchema.parse({
      review: { action: "approve_and_apply" },
      reason: "higher exposure to v2",
      idempotency_key: "idem-1",
    });
    expect(req.review?.action).toBe("approve_and_apply");
    expect(req.reason).toBe("higher exposure to v2");
  });

  it("rejects the removed confirm gate", () => {
    expect(
      StartRunRequestSchema.safeParse({ confirm: true, idempotency_key: "idem-1" }).success,
    ).toBe(false);
  });

  it("rejects a missing idempotency key", () => {
    expect(StartRunRequestSchema.safeParse({ reason: "start it" }).success).toBe(false);
  });

  it("rejects assignment config in the Start body", () => {
    expect(
      StartRunRequestSchema.safeParse({
        allocation: { control: 100 },
        idempotency_key: "idem-1",
      }).success,
    ).toBe(false);
  });
});

describe("PatchRunRequestSchema (.strict, frozen assignment config un-expressible)", () => {
  it("parses a non-material patch", () => {
    const req = PatchRunRequestSchema.parse({
      description: "note",
      owner: "alice",
      tags: ["q3"],
    });
    expect(req.owner).toBe("alice");
  });

  it.each([
    ["salt", { salt: "s" }],
    ["allocation", { allocation: { control: 100 } }],
    ["variantSet", { variantSet: [variantControl] }],
    ["targetingRules", { targetingRules: [] }],
    ["targetingSegmentId", { targetingSegmentId: "seg_1" }],
    ["targetingKey", { targetingKey: "userId" }],
  ])("REJECTS a frozen field: %s", (_label, body) => {
    expect(PatchRunRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe("RunResponseSchema", () => {
  it("parses the full Run leaf with a null endedAt (running)", () => {
    const res = RunResponseSchema.parse({
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
    });
    expect(res.endedAt).toBeNull();
  });
});

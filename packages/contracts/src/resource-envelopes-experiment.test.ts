import { describe, expect, it } from "vitest";
import {
  CreateExperimentRequestSchema,
  ExperimentResponseSchema,
  PatchExperimentRequestSchema,
  PatchRunRequestSchema,
  RunResponseSchema,
  StartRunRequestSchema,
} from "./resource-envelopes-experiment.js";

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

  it("accepts status: 'ended' only", () => {
    expect(PatchExperimentRequestSchema.safeParse({ status: "ended" }).success).toBe(true);
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
      status: "draft",
      targetingKey: "userId",
      targetingKeyType: "user",
      confidenceLevel: 0.95,
      defaultVariantId: "var_1",
      metrics: [{ metricId: "m_1" }],
      guardrailMetrics: [],
      conversionWindowMs: 0,
      dimensions: [],
      liveRunId: null,
      createdAt: "2026-06-28T00:00:00.000Z",
      updatedAt: "2026-06-28T00:00:00.000Z",
    });
    expect(res.liveRunId).toBeNull();
  });
});

const variantControl = { id: "var_1", name: "control", value: false };
const variantTreatment = { id: "var_2", name: "treatment", value: "on" };

const validStartRun = {
  experimentId: "exp_1",
  variantSet: [variantControl, variantTreatment],
  allocation: { control: 50, treatment: 50 },
};

describe("StartRunRequestSchema (the only path to open a Run)", () => {
  it("parses assignment config with no Worker-computed targetingRules", () => {
    const req = StartRunRequestSchema.parse(validStartRun);
    expect(req.allocation.control).toBe(50);
    expect("targetingRules" in req).toBe(false);
  });

  it("exposes an optional confirm gate (gated write, ADR-0029)", () => {
    const req = StartRunRequestSchema.parse({ ...validStartRun, confirm: true });
    expect(req.confirm).toBe(true);
  });

  it("accepts optional salt, targetingSegmentId, reason, idempotency_key", () => {
    const req = StartRunRequestSchema.parse({
      ...validStartRun,
      salt: "fixed-salt",
      targetingSegmentId: "seg_1",
      reason: "higher exposure to v2",
      idempotency_key: "idem-1",
    });
    expect(req.targetingSegmentId).toBe("seg_1");
  });

  it("rejects an allocation that does not sum to 100", () => {
    expect(
      StartRunRequestSchema.safeParse({
        ...validStartRun,
        allocation: { control: 50, treatment: 40 },
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

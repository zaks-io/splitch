import { describe, expect, it } from "vitest";
import {
  CreateExperimentRequestSchema,
  PatchExperimentRequestSchema,
} from "./resource-envelopes-experiment";
import { TargetingKeyTypeSchema, targetingKeyTypes } from "./targeting-key-type";

const allowedMessage = `allowed targetingKeyType values: ${targetingKeyTypes.join(", ")}`;

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

describe("targetingKeyTypes vocabulary", () => {
  it("accepts every canonical Entity type", () => {
    for (const type of targetingKeyTypes) {
      expect(TargetingKeyTypeSchema.parse(type)).toBe(type);
    }
  });

  it("rejects an unrecognized type and names the allowed set", () => {
    const result = TargetingKeyTypeSchema.safeParse("bogus");
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.message).toBe(allowedMessage);
  });
});

describe("CreateExperimentRequestSchema targetingKeyType guard", () => {
  it.each([...targetingKeyTypes])("accepts recognized type %s", (targetingKeyType) => {
    const req = CreateExperimentRequestSchema.parse({
      ...validCreateExperiment,
      targetingKeyType,
    });
    expect(req.targetingKeyType).toBe(targetingKeyType);
  });

  it("rejects an unrecognized targetingKeyType and lists the accepted values", () => {
    const result = CreateExperimentRequestSchema.safeParse({
      ...validCreateExperiment,
      targetingKeyType: "bogus",
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues[0];
    expect(issue?.path).toEqual(["targetingKeyType"]);
    expect(issue?.message).toBe(allowedMessage);
  });
});

describe("PatchExperimentRequestSchema targetingKeyType guard", () => {
  it.each([...targetingKeyTypes])("accepts recognized type %s on update", (targetingKeyType) => {
    const req = PatchExperimentRequestSchema.parse({ targetingKeyType });
    expect(req.targetingKeyType).toBe(targetingKeyType);
  });

  it("rejects an unrecognized targetingKeyType on update and lists the accepted values", () => {
    const result = PatchExperimentRequestSchema.safeParse({ targetingKeyType: "bogus" });
    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues[0];
    expect(issue?.path).toEqual(["targetingKeyType"]);
    expect(issue?.message).toBe(allowedMessage);
  });
});

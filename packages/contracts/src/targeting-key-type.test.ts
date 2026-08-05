import { describe, expect, it } from "vitest";
import {
  CreateExperimentRequestSchema,
  PatchExperimentRequestSchema,
} from "./resource-envelopes-experiment";
import {
  TARGETING_KEY_TYPE_MAX_LENGTH,
  TARGETING_KEY_TYPE_SHAPE_MESSAGE,
  TargetingKeyTypeSchema,
} from "./targeting-key-type";

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

describe("TargetingKeyTypeSchema shape", () => {
  it.each([
    "user",
    "session",
    "workspace",
    "account",
    "restaurant",
    "service_account",
  ])("accepts open-vocabulary type %s", (targetingKeyType) => {
    expect(TargetingKeyTypeSchema.parse(targetingKeyType)).toBe(targetingKeyType);
  });

  it.each([
    ["empty", ""],
    ["uppercase", "User"],
    ["hyphen separator", "user-type"],
    ["space", "user type"],
    ["leading underscore", "_user"],
    ["trailing underscore", "user_"],
    ["double underscore", "user__type"],
    ["too long", "a".repeat(TARGETING_KEY_TYPE_MAX_LENGTH + 1)],
  ])("rejects typo-shaped value (%s)", (_label, value) => {
    const result = TargetingKeyTypeSchema.safeParse(value);
    expect(result.success).toBe(false);
  });

  it("names the shape rule when a typo is rejected", () => {
    const result = TargetingKeyTypeSchema.safeParse("User");
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(
      result.error.issues.some((issue) => issue.message === TARGETING_KEY_TYPE_SHAPE_MESSAGE),
    ).toBe(true);
  });
});

describe("CreateExperimentRequestSchema targetingKeyType shape", () => {
  it("accepts a non-blessed Entity type", () => {
    const req = CreateExperimentRequestSchema.parse({
      ...validCreateExperiment,
      targetingKeyType: "restaurant",
    });
    expect(req.targetingKeyType).toBe("restaurant");
  });

  it("rejects a typo-shaped targetingKeyType", () => {
    const result = CreateExperimentRequestSchema.safeParse({
      ...validCreateExperiment,
      targetingKeyType: "User",
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.path).toEqual(["targetingKeyType"]);
    expect(result.error.issues[0]?.message).toBe(TARGETING_KEY_TYPE_SHAPE_MESSAGE);
  });
});

describe("PatchExperimentRequestSchema targetingKeyType shape", () => {
  it("accepts a non-blessed Entity type on update", () => {
    const req = PatchExperimentRequestSchema.parse({ targetingKeyType: "account" });
    expect(req.targetingKeyType).toBe("account");
  });

  it("rejects a typo-shaped targetingKeyType on update", () => {
    const result = PatchExperimentRequestSchema.safeParse({ targetingKeyType: "user-type" });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.path).toEqual(["targetingKeyType"]);
    expect(result.error.issues[0]?.message).toBe(TARGETING_KEY_TYPE_SHAPE_MESSAGE);
  });
});

import { describe, expect, it } from "vitest";
import {
  EvaluationContextSchema,
  ExposureEventSchema,
  ExposureTypeSchema,
  exposureTypes,
} from "./leaf-schemas-runtime.js";

// A full Exposure row with EVERY required field, incl. the three
// canonically-named timestamps and the `type` discriminator.
const validExposure = {
  dedupKey: "sha256:abc123",
  eventId: "evt_1",
  appId: "app_1",
  environmentId: "env_prod",
  experimentId: "exp_1",
  runId: "run_1",
  idType: "user",
  targetingKeyHash: "hmac:deadbeef",
  variantName: "treatment",
  type: "exposure" as const,
  sourceId: "pop-sjc",
  counterfactual: false,
  clientTimestamp: "2024-01-01T00:00:00Z",
  serverReceivedAt: "2024-01-01T00:00:01Z",
  ingestTs: "2024-01-01T00:00:02Z",
};

describe("EvaluationContextSchema", () => {
  it("parses a context with a non-empty attribute bag", () => {
    const ctx = EvaluationContextSchema.parse({
      targetingKey: "user-42",
      idType: "user",
      attributes: { plan: "enterprise", seats: 12, beta: true, tags: ["a", "b"] },
    });
    expect(ctx.targetingKey).toBe("user-42");
    expect(ctx.attributes.plan).toBe("enterprise");
  });

  it("accepts an empty attributes object", () => {
    const ctx = EvaluationContextSchema.parse({
      targetingKey: "user-42",
      idType: "user",
      attributes: {},
    });
    expect(ctx.attributes).toEqual({});
  });

  it("rejects a missing targetingKey (first-class identifier)", () => {
    expect(EvaluationContextSchema.safeParse({ idType: "user", attributes: {} }).success).toBe(
      false,
    );
  });

  it("rejects a missing idType", () => {
    expect(EvaluationContextSchema.safeParse({ targetingKey: "u", attributes: {} }).success).toBe(
      false,
    );
  });

  it("rejects a nested-object attribute value (scalars/arrays only)", () => {
    expect(
      EvaluationContextSchema.safeParse({
        targetingKey: "u",
        idType: "user",
        attributes: { nested: { deep: 1 } },
      }).success,
    ).toBe(false);
  });
});

describe("ExposureTypeSchema", () => {
  it("accepts every declared type", () => {
    for (const t of exposureTypes) {
      expect(ExposureTypeSchema.safeParse(t).success).toBe(true);
    }
  });

  it("rejects an unknown type loudly", () => {
    expect(ExposureTypeSchema.safeParse("impression").success).toBe(false);
  });
});

describe("ExposureEventSchema", () => {
  it("parses a full valid exposure row with all required fields", () => {
    const e = ExposureEventSchema.parse(validExposure);
    expect(e.dedupKey).toBe("sha256:abc123");
    expect(e.type).toBe("exposure");
    expect(e.counterfactual).toBe(false);
    expect(e.serverReceivedAt).toBe("2024-01-01T00:00:01Z");
    expect(e.ingestTs).toBe("2024-01-01T00:00:02Z");
    expect(e.clientTimestamp).toBe("2024-01-01T00:00:00Z");
  });

  it("parses an activation row against the one Exposure leaf", () => {
    const a = ExposureEventSchema.parse({ ...validExposure, type: "activation" });
    expect(a.type).toBe("activation");
  });

  it("defaults counterfactual to false when omitted (NOT null)", () => {
    const { counterfactual: _, ...withoutCf } = validExposure;
    const e = ExposureEventSchema.parse(withoutCf);
    expect(e.counterfactual).toBe(false);
    expect(e.counterfactual).not.toBeNull();
  });

  it("rejects a null counterfactual (the default is false, not nullable)", () => {
    expect(ExposureEventSchema.safeParse({ ...validExposure, counterfactual: null }).success).toBe(
      false,
    );
  });

  it("rejects an unknown type value loudly", () => {
    expect(ExposureEventSchema.safeParse({ ...validExposure, type: "impression" }).success).toBe(
      false,
    );
  });

  const requiredFields = [
    "dedupKey",
    "eventId",
    "appId",
    "environmentId",
    "experimentId",
    "runId",
    "idType",
    "targetingKeyHash",
    "variantName",
    "type",
    "sourceId",
    "clientTimestamp",
    "serverReceivedAt",
    "ingestTs",
  ] as const;

  for (const field of requiredFields) {
    it(`rejects an exposure missing required field '${field}'`, () => {
      const { [field]: _omitted, ...rest } = validExposure;
      expect(ExposureEventSchema.safeParse(rest).success).toBe(false);
    });
  }
});

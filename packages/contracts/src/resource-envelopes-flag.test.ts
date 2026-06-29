import { describe, expect, it } from "vitest";
import {
  CreateFlagRequestSchema,
  CreateVariantRequestSchema,
  FlagResponseSchema,
  PatchFlagRequestSchema,
  PatchVariantRequestSchema,
} from "./resource-envelopes-flag.js";

const variantControl = { id: "var_1", name: "control", value: false };
const variantTreatment = { id: "var_2", name: "treatment", value: "on" };

const validCreateFlag = {
  appId: "app_1",
  environmentId: "env_prod",
  name: "Feature X",
  key: "feature-x",
  variants: [variantControl, variantTreatment],
  enabled: true,
  defaultVariantId: "var_1",
};

describe("CreateFlagRequestSchema", () => {
  it("parses a minimal request and defaults targetingRules to []", () => {
    const req = CreateFlagRequestSchema.parse(validCreateFlag);
    expect(req.key).toBe("feature-x");
    expect(req.targetingRules).toEqual([]);
  });

  it("parses with optional availableVariantNames and description", () => {
    const req = CreateFlagRequestSchema.parse({
      ...validCreateFlag,
      availableVariantNames: ["control", "treatment"],
      description: "a flag",
    });
    expect(req.availableVariantNames).toEqual(["control", "treatment"]);
  });

  it("rejects an empty variant catalog (min 1)", () => {
    expect(CreateFlagRequestSchema.safeParse({ ...validCreateFlag, variants: [] }).success).toBe(
      false,
    );
  });

  it("rejects a missing key", () => {
    const { key, ...noKey } = validCreateFlag;
    void key;
    expect(CreateFlagRequestSchema.safeParse(noKey).success).toBe(false);
  });
});

describe("PatchFlagRequestSchema (immutable key/appId boundary)", () => {
  it("parses a name-only patch", () => {
    expect(PatchFlagRequestSchema.parse({ name: "Renamed" }).name).toBe("Renamed");
  });

  it("parses an empty patch (all optional)", () => {
    expect(PatchFlagRequestSchema.safeParse({}).success).toBe(true);
  });

  it("REJECTS a patch including immutable key", () => {
    expect(PatchFlagRequestSchema.safeParse({ key: "new-key" }).success).toBe(false);
  });

  it("REJECTS a patch including immutable appId", () => {
    expect(PatchFlagRequestSchema.safeParse({ appId: "app_2" }).success).toBe(false);
  });

  it("rejects an unknown field (strict)", () => {
    expect(PatchFlagRequestSchema.safeParse({ bogus: true }).success).toBe(false);
  });
});

describe("FlagResponseSchema", () => {
  it("parses the full Flag leaf", () => {
    const res = FlagResponseSchema.parse({
      ...validCreateFlag,
      id: "flag_1",
      schema: null,
      availableVariantNames: ["control", "treatment"],
      targetingRules: [],
      createdAt: "2026-06-28T00:00:00.000Z",
      updatedAt: "2026-06-28T00:00:00.000Z",
    });
    expect(res.id).toBe("flag_1");
  });

  it("rejects a response missing audit timestamps", () => {
    expect(FlagResponseSchema.safeParse(validCreateFlag).success).toBe(false);
  });
});

describe("CreateVariantRequestSchema (non-idempotent create)", () => {
  it("parses a request with an optional idempotency_key", () => {
    const req = CreateVariantRequestSchema.parse({
      flagId: "flag_1",
      name: "treatment-b",
      value: { color: "blue" },
      idempotency_key: "idem-1",
    });
    expect(req.idempotency_key).toBe("idem-1");
  });

  it("rejects a missing value", () => {
    expect(CreateVariantRequestSchema.safeParse({ flagId: "flag_1", name: "t" }).success).toBe(
      false,
    );
  });
});

describe("PatchVariantRequestSchema (value is Run-frozen at the Worker)", () => {
  it("parses a value patch (Run-frozen check is a Worker runtime guard)", () => {
    expect(PatchVariantRequestSchema.parse({ value: 42 }).value).toBe(42);
  });

  it("rejects an unknown field (strict)", () => {
    expect(PatchVariantRequestSchema.safeParse({ flagId: "flag_1" }).success).toBe(false);
  });
});

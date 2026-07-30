import { describe, expect, it } from "vitest";
import {
  CreateFlagRequestSchema,
  CreateVariantRequestSchema,
  FlagResponseSchema,
  PatchFlagRequestSchema,
  PatchVariantRequestSchema,
} from "./resource-envelopes-flag";

const variantControl = { name: "control", value: false, isDefault: true };
const variantTreatment = { name: "treatment", value: "on", isDefault: false };

const validCreateFlag = {
  appId: "app_1",
  name: "Feature X",
  key: "feature-x",
  schema: null,
  variants: [variantControl, variantTreatment],
};

describe("CreateFlagRequestSchema", () => {
  it("parses a minimal App-level request", () => {
    const req = CreateFlagRequestSchema.parse(validCreateFlag);
    expect(req.key).toBe("feature-x");
    expect(req.variants.filter((variant) => variant.isDefault)).toHaveLength(1);
  });

  it("parses with optional description", () => {
    const req = CreateFlagRequestSchema.parse({
      ...validCreateFlag,
      description: "a flag",
    });
    expect(req.description).toBe("a flag");
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

  it("parses a schema patch", () => {
    expect(PatchFlagRequestSchema.parse({ schema: { type: "boolean" } }).schema).toEqual({
      type: "boolean",
    });
  });

  it("REJECTS a patch including immutable key", () => {
    expect(PatchFlagRequestSchema.safeParse({ key: "new-key" }).success).toBe(false);
  });

  it("REJECTS a patch including immutable appId", () => {
    expect(PatchFlagRequestSchema.safeParse({ appId: "app_2" }).success).toBe(false);
  });

  it("REJECTS per-Environment fields", () => {
    expect(PatchFlagRequestSchema.safeParse({ enabled: true }).success).toBe(false);
    expect(PatchFlagRequestSchema.safeParse({ availableVariantNames: ["control"] }).success).toBe(
      false,
    );
  });

  it("rejects an unknown field (strict)", () => {
    expect(PatchFlagRequestSchema.safeParse({ bogus: true }).success).toBe(false);
  });
});

describe("FlagResponseSchema", () => {
  it("parses an App-level Flag definition without enabled state", () => {
    const res = FlagResponseSchema.parse({
      id: "flag_1",
      appId: "app_1",
      key: "feature-x",
      name: "Feature X",
      schema: null,
      variants: [
        { id: "var_1", name: "control", value: false },
        { id: "var_2", name: "treatment", value: "on" },
      ],
      defaultVariantId: "var_1",
      createdAt: "2026-06-28T00:00:00.000Z",
      updatedAt: "2026-06-28T00:00:00.000Z",
    });
    expect(res.id).toBe("flag_1");
    expect("enabled" in res).toBe(false);
  });

  it("rejects a response missing audit timestamps", () => {
    expect(FlagResponseSchema.safeParse(validCreateFlag).success).toBe(false);
  });
});

describe("CreateVariantRequestSchema (non-idempotent create)", () => {
  it("parses a request with an optional idempotency_key", () => {
    const req = CreateVariantRequestSchema.parse({
      appId: "app_1",
      flagId: "flag_1",
      name: "treatment-b",
      value: { color: "blue" },
      isDefault: true,
      idempotency_key: "idem-1",
    });
    expect(req.idempotency_key).toBe("idem-1");
    expect(req.isDefault).toBe(true);
  });

  it("rejects a missing value", () => {
    expect(
      CreateVariantRequestSchema.safeParse({ appId: "app_1", flagId: "flag_1", name: "t" }).success,
    ).toBe(false);
  });

  it("rejects an unknown field (strict)", () => {
    expect(
      CreateVariantRequestSchema.safeParse({
        appId: "app_1",
        flagId: "flag_1",
        name: "treatment-b",
        value: true,
        enabled: true,
      }).success,
    ).toBe(false);
  });
});

describe("PatchVariantRequestSchema (value is Run-frozen at the Worker)", () => {
  it("parses a value patch with an optional inline review", () => {
    const request = PatchVariantRequestSchema.parse({
      value: 42,
      review: { action: "approve_and_apply" },
      idempotency_key: "idem-1",
    });
    expect(request.value).toBe(42);
    expect(request.review?.action).toBe("approve_and_apply");
  });

  it("rejects a missing idempotency key", () => {
    expect(PatchVariantRequestSchema.safeParse({ value: 42 }).success).toBe(false);
  });

  it("rejects an unknown field (strict)", () => {
    expect(
      PatchVariantRequestSchema.safeParse({
        flagId: "flag_1",
        idempotency_key: "idem-1",
      }).success,
    ).toBe(false);
  });
});

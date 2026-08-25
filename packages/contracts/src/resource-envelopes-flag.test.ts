import { describe, expect, it } from "vitest";
import {
  CreateFlagRequestSchema,
  CreateVariantRequestSchema,
  FlagListResponseSchema,
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
  idempotency_key: "idem-create-flag",
};

describe("CreateFlagRequestSchema", () => {
  it("parses a minimal App-level request", () => {
    const req = CreateFlagRequestSchema.parse(validCreateFlag);
    expect(req.key).toBe("feature-x");
    expect(req.variants.filter((variant) => variant.isDefault)).toHaveLength(1);
  });

  // `flags_create` is an Idempotency-Key route, so a retried create cannot mint a
  // second definition for a key a gated delete just refused to free.
  it("rejects a request with no idempotency_key", () => {
    const { idempotency_key, ...noKey } = validCreateFlag;
    void idempotency_key;
    expect(CreateFlagRequestSchema.safeParse(noKey).success).toBe(false);
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

  // The key is the system's one slug shape (SlugSchema), same as App keys and
  // Org slugs: a spaced or cased key would be unusable in selectors and URLs.
  it("rejects a key that is not a slug", () => {
    for (const key of ["feature x", "Feature-X", "feature_x", "-feature", "x"]) {
      expect(CreateFlagRequestSchema.safeParse({ ...validCreateFlag, key }).success).toBe(false);
    }
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

describe("FlagListResponseSchema", () => {
  const flag = {
    id: "flag_1",
    appId: "app_1",
    key: "feature-x",
    name: "Feature X",
    schema: null,
    variants: [{ id: "var_1", name: "control", value: false }],
    defaultVariantId: "var_1",
    createdAt: "2026-06-28T00:00:00.000Z",
    updatedAt: "2026-06-28T00:00:00.000Z",
  };

  it("keeps the bare Flag list shape unchanged", () => {
    const response = { items: [flag], readTruncated: false, readLimit: 200 };
    expect(FlagListResponseSchema.parse(response)).toEqual(response);
  });

  it("accepts the bounded per-Environment summary without Targeting Rule detail", () => {
    const response = {
      items: [
        {
          ...flag,
          flagConfiguration: {
            enabled: true,
            rollout: 25,
            defaultVariant: "control",
            availableVariantNames: ["control"],
            targetingRuleRolloutPercentages: [25],
            experiment: null,
          },
        },
      ],
      readTruncated: false,
      readLimit: 200,
    };
    expect(FlagListResponseSchema.parse(response)).toEqual(response);
    expect(response.items[0]?.flagConfiguration).not.toHaveProperty("targetingRules");
  });
});

describe("CreateVariantRequestSchema (Idempotency-Key route)", () => {
  it("parses a request carrying an idempotency_key", () => {
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

  // Without the key the Worker cannot tell a retry from a second Variant, so
  // `flag_variants_create` declares `idempotency: "required"` and the envelope
  // has to refuse a request that omits it.
  it("rejects a request with no idempotency_key", () => {
    expect(
      CreateVariantRequestSchema.safeParse({
        appId: "app_1",
        flagId: "flag_1",
        name: "treatment-b",
        value: true,
      }).success,
    ).toBe(false);
  });

  it("rejects an empty idempotency_key", () => {
    expect(
      CreateVariantRequestSchema.safeParse({
        appId: "app_1",
        flagId: "flag_1",
        name: "treatment-b",
        value: true,
        idempotency_key: "",
      }).success,
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

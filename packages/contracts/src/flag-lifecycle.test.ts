import { describe, expect, it } from "vitest";
import { missingFlagLifecycleInputs } from "./flag-lifecycle";
import { CreateFlagRequestSchema } from "./resource-envelopes-flag";

const createFlag = {
  appId: "app_1",
  name: "Feature X",
  key: "feature-x",
  variants: [{ name: "control", value: false, isDefault: true }],
  lifecycleClass: "permission",
  idempotency_key: "idem-create-flag",
};

describe("missingFlagLifecycleInputs (D9)", () => {
  it("requires owner and expiry for release and experiment Flags", () => {
    for (const lifecycleClass of ["release", "experiment"] as const) {
      expect(missingFlagLifecycleInputs({ lifecycleClass, owner: null, expiresAt: null })).toEqual([
        "owner",
        "expiresAt",
      ]);
    }
  });

  it("names only the input that is missing", () => {
    expect(
      missingFlagLifecycleInputs({ lifecycleClass: "release", owner: "team", expiresAt: null }),
    ).toEqual(["expiresAt"]);
  });

  it("lets ops, permission, and unclassified Flags omit both", () => {
    for (const lifecycleClass of ["ops", "permission", "unclassified"] as const) {
      expect(missingFlagLifecycleInputs({ lifecycleClass, owner: null, expiresAt: null })).toEqual(
        [],
      );
    }
  });
});

describe("CreateFlagRequestSchema lifecycle (D9)", () => {
  it("requires a lifecycle class on every new Flag and names the missing input", () => {
    const { lifecycleClass: _, ...unclassified } = createFlag;
    const result = CreateFlagRequestSchema.safeParse(unclassified);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["lifecycleClass"]);
  });

  it("refuses unclassified as a written class", () => {
    const result = CreateFlagRequestSchema.safeParse({
      ...createFlag,
      lifecycleClass: "unclassified",
    });
    expect(result.success).toBe(false);
  });

  it("accepts an owner and an offset expiry", () => {
    const req = CreateFlagRequestSchema.parse({
      ...createFlag,
      lifecycleClass: "release",
      owner: "checkout-team",
      expiresAt: "2026-12-31T00:00:00+02:00",
    });
    expect(req).toMatchObject({ owner: "checkout-team", expiresAt: "2026-12-31T00:00:00+02:00" });
  });

  it("rejects an expiry that is not a date-time", () => {
    const result = CreateFlagRequestSchema.safeParse({ ...createFlag, expiresAt: "soon" });
    expect(result.success).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import type { User } from "./leaf-schemas-runtime";
import {
  APIKeySchema,
  AppSchema,
  ClientKeySchema,
  EnvironmentSchema,
  EnvironmentPolicySchema,
  OrganizationSchema,
  OrgPlanSchema,
  orgPlans,
  UserRoleSchema,
  userRoles,
  UserSchema,
} from "./leaf-schemas-runtime";

describe("Organization", () => {
  const validOrg = {
    id: "org_1",
    name: "Acme",
    slug: "acme",
    plan: "free" as const,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  };

  it("accepts every declared plan", () => {
    for (const p of orgPlans) {
      expect(OrgPlanSchema.safeParse(p).success).toBe(true);
    }
  });

  it("parses a valid organization", () => {
    expect(OrganizationSchema.parse(validOrg).plan).toBe("free");
  });

  it("rejects an unknown plan", () => {
    expect(OrganizationSchema.safeParse({ ...validOrg, plan: "scale" }).success).toBe(false);
  });

  it("rejects a missing name", () => {
    const { name: _, ...rest } = validOrg;
    expect(OrganizationSchema.safeParse(rest).success).toBe(false);
  });
});

describe("App", () => {
  const validApp = {
    id: "app_1",
    organizationId: "org_1",
    name: "Web",
    key: "web",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  };

  it("parses a valid app without the optional description", () => {
    expect(AppSchema.parse(validApp).key).toBe("web");
  });

  it("parses a valid app with a description", () => {
    expect(AppSchema.parse({ ...validApp, description: "the web app" }).description).toBe(
      "the web app",
    );
  });

  it("rejects a missing organizationId (owning Organization)", () => {
    const { organizationId: _, ...rest } = validApp;
    expect(AppSchema.safeParse(rest).success).toBe(false);
  });
});

describe("Environment", () => {
  const allowPolicy = {
    variantAvailability: "allow",
    targetingRolloutValue: "allow",
    enabledState: "allow",
    startExperimentRun: "allow",
  } as const;

  const validEnv = {
    id: "env_1",
    appId: "app_1",
    key: "production",
    name: "Production",
    policy: allowPolicy,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  };

  it("parses a valid environment", () => {
    expect(EnvironmentSchema.parse(validEnv).key).toBe("production");
  });

  it("rejects a missing appId (owning App)", () => {
    const { appId: _, ...rest } = validEnv;
    expect(EnvironmentSchema.safeParse(rest).success).toBe(false);
  });

  it("parses the inline Environment Policy", () => {
    expect(EnvironmentPolicySchema.parse(allowPolicy).enabledState).toBe("allow");
    expect(
      EnvironmentPolicySchema.safeParse({ ...allowPolicy, enabledState: "approve" }).success,
    ).toBe(false);
  });

  it("rejects an Environment without policy", () => {
    const { policy: _, ...rest } = validEnv;
    expect(EnvironmentSchema.safeParse(rest).success).toBe(false);
  });
});

describe("User (WorkOS + membership, NOT a D1 PII table)", () => {
  const validUser = {
    id: "user_1",
    email: "a@example.com",
    organizationId: "org_1",
    role: "owner" as const,
    createdAt: "2024-01-01T00:00:00Z",
  };

  it("accepts every declared role", () => {
    for (const r of userRoles) {
      expect(UserRoleSchema.safeParse(r).success).toBe(true);
    }
  });

  it("parses a valid user", () => {
    expect(UserSchema.parse(validUser).role).toBe("owner");
  });

  it("rejects an unknown role", () => {
    expect(UserSchema.safeParse({ ...validUser, role: "viewer" }).success).toBe(false);
  });

  it("carries no PII storage columns beyond the assembled identity fields", () => {
    // The User leaf is assembled from WorkOS profile + D1 membership rows; it is
    // not a D1 PII storage table. The inferred key set is exactly these fields —
    // no phone/name/address/etc. PII columns leak in.
    type Key = keyof User;
    type Allowed = "id" | "email" | "organizationId" | "role" | "createdAt";
    type Extra = Exclude<Key, Allowed>;
    const _assertNoExtra: Extra extends never ? true : never = true;
    expect(_assertNoExtra).toBe(true);
  });
});

describe("ClientKey (public)", () => {
  const validClientKey = {
    keyId: "ck_01",
    appId: "app_1",
    environmentId: "env_1",
    keyMaterial: "pk_live_public",
    isOriginOpen: true,
    createdAt: "2024-01-01T00:00:00Z",
  };

  it("parses a client key with public keyMaterial present", () => {
    expect(ClientKeySchema.parse(validClientKey).keyMaterial).toBe("pk_live_public");
  });

  it("accepts a null originAllowlist (open to all origins)", () => {
    const ck = ClientKeySchema.parse({ ...validClientKey, originAllowlist: null });
    expect(ck.originAllowlist).toBeNull();
    expect(ck.isOriginOpen).toBe(true);
  });

  it("accepts an empty originAllowlist (closed, serves nothing)", () => {
    expect(
      ClientKeySchema.parse({ ...validClientKey, originAllowlist: [] }).originAllowlist,
    ).toEqual([]);
  });

  it("accepts a non-empty originAllowlist", () => {
    const ck = ClientKeySchema.parse({
      ...validClientKey,
      originAllowlist: ["https://app.example.com"],
    });
    expect(ck.originAllowlist).toEqual(["https://app.example.com"]);
  });

  it("rejects a missing keyMaterial (required public value)", () => {
    const { keyMaterial: _, ...rest } = validClientKey;
    expect(ClientKeySchema.safeParse(rest).success).toBe(false);
  });

  it("rejects an API Key's scopes under .strict() (keeps the leaf disjoint from APIKey)", () => {
    expect(ClientKeySchema.safeParse({ ...validClientKey, scopes: ["flags:read"] }).success).toBe(
      false,
    );
  });
});

describe("APIKey (secret)", () => {
  const validApiKey = {
    keyId: "ak_01",
    appId: "app_1",
    environmentId: "env_1",
    scopes: ["flags:read", "experiments:write"],
    createdAt: "2024-01-01T00:00:00Z",
  };

  it("parses a valid API key with no key-material field", () => {
    const k = APIKeySchema.parse(validApiKey);
    expect(k.scopes).toHaveLength(2);
    expect("keyMaterial" in k).toBe(false);
  });

  it("rejects an extra keyMaterial field under .strict() (no secret rides this shape)", () => {
    expect(APIKeySchema.safeParse({ ...validApiKey, keyMaterial: "sk_secret_raw" }).success).toBe(
      false,
    );
  });

  it("rejects any unknown field under .strict()", () => {
    expect(APIKeySchema.safeParse({ ...validApiKey, hash: "abc" }).success).toBe(false);
  });

  it("rejects a missing scopes array", () => {
    const { scopes: _, ...rest } = validApiKey;
    expect(APIKeySchema.safeParse(rest).success).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  AppResponseSchema,
  CreateAppRequestSchema,
  CreateCredentialResponseSchema,
  CreateMetricRequestSchema,
  CredentialSchema,
  ListCredentialsResponseSchema,
  MetricResponseSchema,
  OrganizationResponseSchema,
  PatchAppRequestSchema,
  PatchMetricRequestSchema,
  PatchOrganizationRequestSchema,
} from "./resource-envelopes-account";

describe("CreateMetricRequestSchema", () => {
  it("parses a binomial metric", () => {
    const req = CreateMetricRequestSchema.parse({
      appId: "app_1",
      name: "Signup",
      key: "signup",
      kind: "binomial",
      eventDefinitionId: "signed_up",
    });
    expect(req.kind).toBe("binomial");
  });

  it("accepts an optional idempotency_key", () => {
    const req = CreateMetricRequestSchema.parse({
      appId: "app_1",
      name: "Revenue",
      key: "rev",
      kind: "revenue",
      eventDefinitionId: "purchase",
      eventFieldName: "amount",
      idempotency_key: "idem-1",
    });
    expect(req.idempotency_key).toBe("idem-1");
  });

  it("rejects an invalid kind", () => {
    expect(
      CreateMetricRequestSchema.safeParse({
        appId: "app_1",
        name: "X",
        key: "x",
        kind: "gauge",
        eventDefinitionId: "e",
      }).success,
    ).toBe(false);
  });
});

describe("PatchMetricRequestSchema", () => {
  it("parses a name+key patch (key is patchable on Metric)", () => {
    const req = PatchMetricRequestSchema.parse({ name: "Renamed", key: "new-key" });
    expect(req.key).toBe("new-key");
  });

  it("rejects an unknown field (strict)", () => {
    expect(PatchMetricRequestSchema.safeParse({ appId: "app_2" }).success).toBe(false);
  });
});

describe("MetricResponseSchema", () => {
  it("parses a ratio metric leaf with denominator", () => {
    const res = MetricResponseSchema.parse({
      id: "m_1",
      appId: "app_1",
      key: "ctr",
      name: "CTR",
      kind: "ratio",
      eventDefinitionId: "click",
      denominator: { metricId: "m_0" },
      createdAt: "2026-06-28T00:00:00.000Z",
    });
    expect(res.kind).toBe("ratio");
  });

  it("rejects a ratio metric missing its denominator", () => {
    expect(
      MetricResponseSchema.safeParse({
        id: "m_1",
        appId: "app_1",
        key: "ctr",
        name: "CTR",
        kind: "ratio",
        eventDefinitionId: "click",
        createdAt: "2026-06-28T00:00:00.000Z",
      }).success,
    ).toBe(false);
  });
});

describe("CreateAppRequestSchema / PatchAppRequestSchema", () => {
  it("parses a create request", () => {
    const req = CreateAppRequestSchema.parse({
      organizationId: "org_1",
      name: "Checkout",
      key: "checkout",
    });
    expect(req.key).toBe("checkout");
  });

  it("rejects a key shaped like a canonical identifier", () => {
    // Selector lookups accept an App ID or an App key, and keys are unique per
    // Org only. A key of `app_<other tenant's id>` would otherwise be a usable
    // impersonation of another Org's App.
    // `checkout-`/`a` pin that App keys share the Organization slug shape
    // rather than a looser App-only rule the Panel form would disagree with.
    for (const key of [
      "app_01hxyz",
      "org_01hxyz",
      "Checkout",
      "check out",
      "",
      "a",
      "checkout-",
      "check--out",
    ]) {
      expect(
        CreateAppRequestSchema.safeParse({ organizationId: "org_1", name: "Checkout", key })
          .success,
      ).toBe(false);
    }
  });

  it("rejects an immutable key/organizationId on patch (strict)", () => {
    expect(PatchAppRequestSchema.safeParse({ key: "new" }).success).toBe(false);
    expect(PatchAppRequestSchema.safeParse({ organizationId: "org_2" }).success).toBe(false);
    expect(PatchAppRequestSchema.safeParse({ name: "Renamed" }).success).toBe(true);
  });
});

describe("AppResponseSchema / OrganizationResponseSchema", () => {
  it("parses an App leaf and rejects a bad Org plan", () => {
    expect(
      AppResponseSchema.safeParse({
        id: "app_1",
        organizationId: "org_1",
        name: "Checkout",
        key: "checkout",
        createdAt: "2026-06-28T00:00:00.000Z",
        updatedAt: "2026-06-28T00:00:00.000Z",
      }).success,
    ).toBe(true);
    expect(
      OrganizationResponseSchema.safeParse({
        id: "org_1",
        name: "Acme",
        plan: "platinum",
        createdAt: "2026-06-28T00:00:00.000Z",
        updatedAt: "2026-06-28T00:00:00.000Z",
      }).success,
    ).toBe(false);
  });
});

describe("PatchOrganizationRequestSchema", () => {
  it("parses a plan change and rejects an immutable id (strict)", () => {
    expect(PatchOrganizationRequestSchema.parse({ plan: "pro" }).plan).toBe("pro");
    expect(PatchOrganizationRequestSchema.safeParse({ id: "org_2" }).success).toBe(false);
  });
});

const clientKeyLeaf = {
  keyId: "ck_1",
  appId: "app_1",
  environmentId: "env_dev",
  keyMaterial: "pk_public",
  isOriginOpen: true,
  createdAt: "2026-06-28T00:00:00.000Z",
};

const apiKeyLeaf = {
  keyId: "ak_1",
  appId: "app_1",
  environmentId: "env_dev",
  scopes: ["flags:read"],
  createdAt: "2026-06-28T00:00:00.000Z",
};

// An API-key-shaped object that ALSO carries a secret `keyMaterial`. Before both
// credential leaves were `.strict()`, the union absorbed this into the public
// ClientKey member with `keyMaterial` surviving in the output — a secret leak.
const secretBearingApiKeyShape = {
  keyId: "ak_1",
  appId: "app_1",
  environmentId: "env_dev",
  scopes: ["flags:read"],
  keyMaterial: "sk_SECRET",
  createdAt: "2026-06-28T00:00:00.000Z",
};

describe("Credential responses", () => {
  it("CreateCredentialResponse carries the credential leaf + raw value", () => {
    const res = CreateCredentialResponseSchema.parse({
      credential: apiKeyLeaf,
      value: "sk_raw_secret",
    });
    expect(res.value).toBe("sk_raw_secret");
  });

  it("CredentialSchema parses a valid API key as the APIKey member (no keyMaterial)", () => {
    const cred = CredentialSchema.parse(apiKeyLeaf);
    expect("keyMaterial" in cred).toBe(false);
    expect("scopes" in cred).toBe(true);
  });

  it("CredentialSchema parses a valid Client key with public keyMaterial", () => {
    const cred = CredentialSchema.parse(clientKeyLeaf);
    expect("keyMaterial" in cred && cred.keyMaterial).toBe("pk_public");
  });

  it("ListCredentialsResponse parses a mix of API and Client keys", () => {
    const res = ListCredentialsResponseSchema.parse({
      items: [apiKeyLeaf, clientKeyLeaf],
    });
    expect(res.items).toHaveLength(2);
  });

  it("CredentialSchema REJECTS a secret-bearing API-key-shaped object (no leak)", () => {
    expect(CredentialSchema.safeParse(secretBearingApiKeyShape).success).toBe(false);
  });

  it("ListCredentialsResponse REJECTS a secret-bearing API-key-shaped item (no leak)", () => {
    expect(
      ListCredentialsResponseSchema.safeParse({ items: [secretBearingApiKeyShape] }).success,
    ).toBe(false);
  });

  it("rejects an item matching neither credential leaf (closed union)", () => {
    expect(
      ListCredentialsResponseSchema.safeParse({
        items: [{ appId: "app_1", environmentId: "env_dev" }],
      }).success,
    ).toBe(false);
  });
});

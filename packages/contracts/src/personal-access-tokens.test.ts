import { z } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";
import {
  accessTokenAuthDoorFromClaim,
  CreatePersonalAccessTokenRequestSchema,
  getRoute,
  isPersonalAccessTokenSecret,
  type PersonalAccessTokenGrant,
  PersonalAccessTokenGrantSchema,
  personalAccessTokenAuthority,
  personalAccessTokenExpired,
  personalAccessTokenPermissions,
  UpdatePersonalAccessTokenRequestSchema,
} from "./index";

import { personalAccessTokenRoutes } from "./routes/routes-personal-access-tokens";

const MEMBERSHIPS = {
  organizations: [
    { id: "org_a", role: "owner" as const },
    { id: "org_b", role: "member" as const },
  ],
  apps: [
    { id: "app_a1", organizationId: "org_a", role: "owner" as const },
    { id: "app_a2", organizationId: "org_a", role: "admin" as const },
    { id: "app_b1", organizationId: "org_b", role: "member" as const },
  ],
};

function grant(
  target: string,
  role: PersonalAccessTokenGrant["role"],
  permissions: PersonalAccessTokenGrant["permissions"] = ["write"],
): PersonalAccessTokenGrant {
  return { target, role, permissions };
}

describe("personalAccessTokenAuthority", () => {
  it("an all grant mirrors live membership, capped at its role ceiling for every permission", () => {
    const authority = personalAccessTokenAuthority(MEMBERSHIPS, [
      grant("all", "admin", [...personalAccessTokenPermissions]),
    ]);
    const scopes = [
      "app:app_a1:admin",
      "app:app_a2:admin",
      "app:app_b1:member",
      "org:org_a:admin",
      "org:org_b:member",
    ];
    expect(authority.scopes).toEqual(scopes);
    expect(Object.keys(authority.permissions)).toEqual(personalAccessTokenPermissions);
    for (const permission of personalAccessTokenPermissions) {
      expect(authority.permissions[permission]).toEqual({ scopes, all: true });
    }
  });

  it("never raises a role above the live membership", () => {
    const authority = personalAccessTokenAuthority(MEMBERSHIPS, [grant("org:org_b", "owner")]);
    const scopes = ["app:app_b1:member", "org:org_b:member"];
    expect(authority.scopes).toEqual(scopes);
    expect(authority.permissions.write).toEqual({ scopes, all: false });
  });

  it("an Organization grant covers its Apps; an App grant covers only that App", () => {
    expect(
      personalAccessTokenAuthority(MEMBERSHIPS, [grant("org:org_a", "member")]).scopes,
    ).toEqual(["app:app_a1:member", "app:app_a2:member", "org:org_a:member"]);
    expect(
      personalAccessTokenAuthority(MEMBERSHIPS, [grant("app:app_a2", "owner")]).scopes,
    ).toEqual(["app:app_a2:admin"]);
  });

  it("grants naming a target the user no longer belongs to add nothing", () => {
    const authority = personalAccessTokenAuthority(MEMBERSHIPS, [
      grant("app:app_gone", "owner", [...personalAccessTokenPermissions]),
      grant("org:org_gone", "owner", [...personalAccessTokenPermissions]),
    ]);
    expect(authority.scopes).toEqual([]);
    for (const permission of personalAccessTokenPermissions) {
      expect(authority.permissions[permission]).toEqual({ scopes: [], all: false });
    }
  });

  it("read-only grants never contribute their higher role to a permission", () => {
    const authority = personalAccessTokenAuthority(MEMBERSHIPS, [
      grant("all", "owner", []),
      grant("app:app_a1", "member", ["write"]),
    ]);
    expect(authority.scopes).toContain("org:org_a:owner");
    expect(authority.permissions.write).toEqual({ scopes: ["app:app_a1:member"], all: false });
    expect(authority.permissions.credentials).toEqual({ scopes: [], all: false });
  });

  it("uses the highest ceiling among only grants carrying each permission", () => {
    const authority = personalAccessTokenAuthority(MEMBERSHIPS, [
      grant("org:org_a", "member", ["write"]),
      grant("app:app_a1", "admin", ["credentials"]),
      grant("app:app_a1", "owner", ["privacy"]),
      grant("app:app_a1", "admin", ["write"]),
    ]);
    expect(authority.scopes).toContain("app:app_a1:owner");
    expect(authority.permissions.write.scopes).toEqual([
      "app:app_a1:admin",
      "app:app_a2:member",
      "org:org_a:member",
    ]);
    expect(authority.permissions.credentials.scopes).toEqual(["app:app_a1:admin"]);
    expect(authority.permissions.privacy.scopes).toEqual(["app:app_a1:owner"]);
    expect(authority.permissions.delete.scopes).toEqual([]);
    expect(authority.permissions.members.scopes).toEqual([]);
  });

  it("does not borrow a higher credentials ceiling for write on the same target", () => {
    const authority = personalAccessTokenAuthority(MEMBERSHIPS, [
      grant("org:org_a", "member", ["write"]),
      grant("app:app_a1", "admin", ["credentials"]),
    ]);
    expect(authority.permissions.write.scopes).toContain("app:app_a1:member");
    expect(authority.permissions.credentials.scopes).toEqual(["app:app_a1:admin"]);
  });

  it("requires an all grant to carry the permission for a path-less mutation", () => {
    const authority = personalAccessTokenAuthority(MEMBERSHIPS, [
      grant("all", "member", ["write"]),
      grant("org:org_a", "owner", ["privacy"]),
    ]);
    expect(authority.permissions.write.all).toBe(true);
    expect(authority.permissions.privacy.all).toBe(false);
    expect(authority.permissions.delete.all).toBe(false);
  });

  it("does not invent memberships for a user without any", () => {
    const authority = personalAccessTokenAuthority({ organizations: [], apps: [] }, [
      grant("all", "owner", ["write"]),
    ]);
    expect(authority.scopes).toEqual([]);
    expect(authority.permissions.write).toEqual({ scopes: [], all: true });
  });
});

describe("principal capabilities Personal Access Token metadata", () => {
  it("exposes the same complete permission authority record and rejects legacy metadata", () => {
    const route = getRoute("principal_capabilities_get");
    if (!route) throw new Error("missing principal_capabilities_get route");
    const authority = personalAccessTokenAuthority(MEMBERSHIPS, [
      grant("all", "member", ["write", "privacy"]),
    ]);
    const response = {
      scopes: authority.scopes,
      membershipWideRead: false,
      personalAccessToken: { id: `pat_${"0".repeat(32)}`, permissions: authority.permissions },
    };
    expect(route.output.safeParse(response).success).toBe(true);
    const token = {
      id: response.personalAccessToken.id,
      name: "headless",
      grants: [grant("all", "member", ["write", "privacy"])],
      expiresAt: null,
      effective: authority,
    };
    expect(route.output.safeParse({ ...response, token }).success).toBe(true);
    expect(
      route.output.safeParse({
        ...response,
        token: { ...token, effective: { ...authority, permissions: {} } },
      }).success,
    ).toBe(false);

    expect(
      route.output.safeParse({
        ...response,
        personalAccessToken: { ...response.personalAccessToken, writeScopes: [], writeAll: true },
      }).success,
    ).toBe(false);
    const { privacy: _privacy, ...incomplete } = authority.permissions;
    expect(
      route.output.safeParse({
        ...response,
        personalAccessToken: { ...response.personalAccessToken, permissions: incomplete },
      }).success,
    ).toBe(false);
  });
});

describe("personal access token request schemas", () => {
  it.each([
    {
      operationId: "personal_access_tokens_create",
      input: { body: { name: "scoped", grants: [grant("app:app_a1", "member", [])] } },
    },
    {
      operationId: "personal_access_tokens_update",
      input: { params: { tokenId: `pat_${"1".repeat(32)}` }, body: { name: "renamed" } },
    },
    {
      operationId: "personal_access_tokens_rotate",
      input: { params: { tokenId: `pat_${"1".repeat(32)}` } },
    },
  ])(
    "accepts $operationId without a headers object as the released CLI sends it",
    ({ operationId, input }) => {
      const route = getRoute(operationId);
      if (!route) throw new Error(`missing ${operationId} route`);
      expect(route.input.safeParse(input).success).toBe(true);
      const schema = z.toJSONSchema(route.input, { io: "input" });
      expect(schema.required ?? []).not.toContain("headers");
    },
  );

  it("declares the dedicated optional approval header on create, update, and rotate", () => {
    for (const route of [
      personalAccessTokenRoutes[1],
      personalAccessTokenRoutes[2],
      personalAccessTokenRoutes[3],
    ]) {
      const headers = route.openapi.request?.headers;
      expect(headers).toBeInstanceOf(z.ZodObject);
      if (!(headers instanceof z.ZodObject)) throw new Error("missing approval header schema");
      expect(headers.safeParse({}).success).toBe(true);
      expect(headers.parse({ "splitch-pat-authorization": "approval" })).toEqual({
        "splitch-pat-authorization": "approval",
      });
      expect(headers.safeParse({ "splitch-pat-authorization": "" }).success).toBe(false);
    }
  });

  it("accepts an explicit never-expiring token and rejects an empty grant list", () => {
    expect(
      CreatePersonalAccessTokenRequestSchema.safeParse({
        name: "sandboxes",
        grants: [grant("all", "member", [])],
        expiresAt: null,
      }).success,
    ).toBe(true);
    expect(
      CreatePersonalAccessTokenRequestSchema.safeParse({ name: "x", grants: [] }).success,
    ).toBe(false);
  });

  it("rejects malformed grant targets and unknown fields", () => {
    for (const target of ["*", "org:", "app:a:b", "team:t1", "", "app:checkout", "org:acme"]) {
      expect(
        CreatePersonalAccessTokenRequestSchema.safeParse({
          name: "x",
          grants: [grant(target, "member")],
        }).success,
        target,
      ).toBe(false);
    }
    expect(
      CreatePersonalAccessTokenRequestSchema.safeParse({
        name: "x",
        grants: [grant("all", "member")],
        secret: "spl_pat_x",
      }).success,
    ).toBe(false);
  });

  it("rejects legacy access, omitted permissions, unknown permissions, and duplicates", () => {
    for (const value of [
      { target: "all", role: "member", access: "read-write" },
      { target: "all", role: "member" },
      { target: "all", role: "member", permissions: ["read"] },
      { target: "all", role: "member", permissions: ["write", "write"] },
      { target: "all", role: "member", permissions: [], access: "read" },
      { target: "all", role: "member", permissions: [], extra: true },
    ]) {
      expect(PersonalAccessTokenGrantSchema.safeParse(value).success).toBe(false);
    }
  });

  it("canonicalizes permissions without changing their meaning", () => {
    expect(
      PersonalAccessTokenGrantSchema.parse(
        grant("all", "member", ["privacy", "members", "credentials", "delete", "write"]),
      ).permissions,
    ).toEqual(personalAccessTokenPermissions);
    expect(PersonalAccessTokenGrantSchema.parse(grant("all", "member", [])).permissions).toEqual(
      [],
    );
  });

  it("an update must change something", () => {
    expect(UpdatePersonalAccessTokenRequestSchema.safeParse({}).success).toBe(false);
    expect(UpdatePersonalAccessTokenRequestSchema.safeParse({ expiresAt: null }).success).toBe(
      true,
    );
  });
});

describe("personal access token helpers", () => {
  it("recognizes only the exact secret shape", () => {
    expect(isPersonalAccessTokenSecret(`spl_pat_${"a".repeat(64)}`)).toBe(true);
    expect(isPersonalAccessTokenSecret(`spl_pat_${"a".repeat(63)}`)).toBe(false);
    expect(isPersonalAccessTokenSecret("eyJhbGciOiJSUzI1NiJ9.e30.sig")).toBe(false);
  });

  it("treats null as never expiring and an unparseable expiry as expired", () => {
    expect(personalAccessTokenExpired(null, Date.now())).toBe(false);
    expect(personalAccessTokenExpired("2026-01-01T00:00:00.000Z", Date.parse("2026-06-01"))).toBe(
      true,
    );
    expect(personalAccessTokenExpired("2027-01-01T00:00:00.000Z", Date.parse("2026-06-01"))).toBe(
      false,
    );
    expect(personalAccessTokenExpired("not-a-date", Date.now())).toBe(true);
  });
});

describe("accessTokenAuthDoorFromClaim", () => {
  it("never lets a JWT claim the Personal Access Token door", () => {
    expect(accessTokenAuthDoorFromClaim("personal_access_token")).toBe("anonymous");
    expect(accessTokenAuthDoorFromClaim("device_flow")).toBe("device_flow");
    expect(accessTokenAuthDoorFromClaim("not-a-door")).toBe("anonymous");
    expect(accessTokenAuthDoorFromClaim(undefined)).toBe("anonymous");
  });
});

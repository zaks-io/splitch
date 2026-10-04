import { describe, expect, it } from "vitest";
import {
  accessTokenAuthDoorFromClaim,
  CreatePersonalAccessTokenRequestSchema,
  createMcpDelegationHeader,
  isPersonalAccessTokenSecret,
  type PersonalAccessTokenGrant,
  parseMcpDelegation,
  personalAccessTokenAuthority,
  personalAccessTokenExpired,
  UpdatePersonalAccessTokenRequestSchema,
} from "./index";
import {
  memoryReplayGuard,
  resignCredential,
  SECRET,
  withCredential,
} from "./mcp-delegation-test-fixtures";

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
  access: PersonalAccessTokenGrant["access"] = "read-write",
): PersonalAccessTokenGrant {
  return { target, role, access };
}

describe("personalAccessTokenAuthority", () => {
  it("an `all` grant mirrors live membership, capped at its role ceiling", () => {
    expect(personalAccessTokenAuthority(MEMBERSHIPS, [grant("all", "admin")])).toEqual({
      scopes: [
        "app:app_a1:admin",
        "app:app_a2:admin",
        "app:app_b1:member",
        "org:org_a:admin",
        "org:org_b:member",
      ],
      writeScopes: [
        "app:app_a1:admin",
        "app:app_a2:admin",
        "app:app_b1:member",
        "org:org_a:admin",
        "org:org_b:member",
      ],
      writeAll: true,
    });
  });

  it("never raises a role above the live membership", () => {
    const authority = personalAccessTokenAuthority(MEMBERSHIPS, [grant("org:org_b", "owner")]);
    expect(authority.scopes).toEqual(["app:app_b1:member", "org:org_b:member"]);
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
      grant("app:app_gone", "owner"),
      grant("org:org_gone", "owner"),
    ]);
    expect(authority).toEqual({ scopes: [], writeScopes: [], writeAll: false });
  });

  it("read grants contribute to reads only; write authority comes from read-write grants", () => {
    const authority = personalAccessTokenAuthority(MEMBERSHIPS, [
      grant("all", "owner", "read"),
      grant("app:app_a1", "member", "read-write"),
    ]);
    expect(authority.scopes).toContain("org:org_a:owner");
    expect(authority.writeScopes).toEqual(["app:app_a1:member"]);
    expect(authority.writeAll).toBe(false);
  });

  it("the highest applicable ceiling wins when grants overlap", () => {
    const authority = personalAccessTokenAuthority(MEMBERSHIPS, [
      grant("all", "member", "read"),
      grant("app:app_a1", "admin", "read"),
    ]);
    expect(authority.scopes).toContain("app:app_a1:admin");
    expect(authority.scopes).toContain("app:app_a2:member");
  });
});

describe("personal access token request schemas", () => {
  it("accepts an explicit never-expiring token and rejects an empty grant list", () => {
    expect(
      CreatePersonalAccessTokenRequestSchema.safeParse({
        name: "sandboxes",
        grants: [grant("all", "member", "read")],
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

describe("PAT MCP delegation", () => {
  const TOKEN_ID = `pat_${"0".repeat(32)}`;
  const TOKEN_HASH = "e".repeat(64);
  const request = () => new Request("https://control-plane.internal/apps/app_one/flags");

  it("round-trips the token id on a live personal_access_token delegation", async () => {
    const credential = await createMcpDelegationHeader({
      operationId: "flags_list",
      actor: {
        subject: "user_one",
        scopes: [],
        liveMembership: true,
        authDoor: "personal_access_token",
        personalAccessTokenId: TOKEN_ID,
        personalAccessTokenHash: TOKEN_HASH,
      },
      request: request(),
      secret: SECRET,
      nowSeconds: 100,
      jti: "delegation-id-pat-one",
    });
    await expect(
      parseMcpDelegation({
        request: withCredential(request(), credential),
        surface: "control-plane-api",
        secret: SECRET,
        replayGuard: memoryReplayGuard(),
        nowSeconds: 100,
      }),
    ).resolves.toEqual({
      subject: "user_one",
      scopes: [],
      liveMembership: true,
      authDoor: "personal_access_token",
      personalAccessTokenId: TOKEN_ID,
      personalAccessTokenHash: TOKEN_HASH,
    });
  });

  it("refuses to mint a PAT door without a token id, or a token id on another door", async () => {
    const base = { subject: "user_one", scopes: [], liveMembership: true as const };
    for (const actor of [
      { ...base, authDoor: "personal_access_token" as const },
      { ...base, authDoor: "personal_access_token" as const, personalAccessTokenId: TOKEN_ID },
      {
        ...base,
        authDoor: "device_flow" as const,
        personalAccessTokenId: TOKEN_ID,
        personalAccessTokenHash: TOKEN_HASH,
      },
      {
        subject: "user_one",
        scopes: [],
        authDoor: "personal_access_token" as const,
        personalAccessTokenId: TOKEN_ID,
        personalAccessTokenHash: TOKEN_HASH,
      },
    ]) {
      await expect(
        createMcpDelegationHeader({
          operationId: "flags_list",
          actor,
          request: request(),
          secret: SECRET,
          nowSeconds: 100,
        }),
      ).rejects.toThrow(/personal_access_token/);
    }
  });

  it("rejects a signed credential whose door and token id disagree", async () => {
    const credential = await createMcpDelegationHeader({
      operationId: "flags_list",
      actor: { subject: "user_one", scopes: [], liveMembership: true, authDoor: "device_flow" },
      request: request(),
      secret: SECRET,
      nowSeconds: 100,
    });
    for (const patch of [
      { personalAccessTokenId: TOKEN_ID, personalAccessTokenHash: TOKEN_HASH },
      { authDoor: "personal_access_token" },
      { authDoor: "personal_access_token", personalAccessTokenId: TOKEN_ID },
      {
        authDoor: "personal_access_token",
        personalAccessTokenId: "pat_short",
        personalAccessTokenHash: TOKEN_HASH,
      },
      {
        authDoor: "personal_access_token",
        personalAccessTokenId: TOKEN_ID,
        personalAccessTokenHash: "not-hex",
      },
    ]) {
      await expect(
        parseMcpDelegation({
          request: withCredential(request(), await resignCredential(credential, patch)),
          surface: "control-plane-api",
          secret: SECRET,
          replayGuard: memoryReplayGuard(),
          nowSeconds: 100,
        }),
      ).resolves.toBeNull();
    }
  });
});

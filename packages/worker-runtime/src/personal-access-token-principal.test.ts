import {
  createMcpDelegationHeader,
  getRoute,
  MCP_DELEGATION_HEADER,
  type McpDelegationReplayGuard,
  type PersonalAccessTokenAuthority,
  personalAccessTokenAuthority,
  type RouteContract,
  routeRegistry,
} from "@splitch/contracts";
import { describe, expect, it, vi } from "vitest";
import { makeMcpDelegationAuthResolver } from "./mcp-delegation-auth";
import type { Principal } from "./principal";
import { narrowPersonalAccessTokenForRoute } from "./steps/personal-access-token-write";

const SECRET = "d".repeat(32);
const TOKEN_ID = `pat_${"1".repeat(32)}`;
const TOKEN_HASH = "e".repeat(64);

describe("Personal Access Token MCP principal", () => {
  it("builds the principal from the clamped authority, never from live membership alone", async () => {
    const resolveLiveScopes = vi.fn(async () => ["app:app_other:owner"]);
    const resolvePersonalAccessToken = vi.fn(async () => ({
      scopes: ["app:app_one:admin"],
      permissions: emptyPermissions(),
    }));
    const resolver = makeMcpDelegationAuthResolver({
      surface: "control-plane-api",
      secret: SECRET,
      replayGuard: memoryReplayGuard(),
      resolveLiveScopes,
      resolvePersonalAccessToken,
    });

    await expect(resolver(await patRequest())).resolves.toEqual({
      ok: true,
      principal: {
        kind: "control-plane-token",
        id: "user_one",
        scopes: ["app:app_one:admin"],
        orgId: null,
        appId: "app_one",
        environmentId: null,
        authDoor: "personal_access_token",
        liveMembership: true,
        personalAccessToken: { id: TOKEN_ID, permissions: emptyPermissions() },
      },
    });
    expect(resolvePersonalAccessToken).toHaveBeenCalledWith({
      subject: "user_one",
      tokenId: TOKEN_ID,
      tokenHash: TOKEN_HASH,
    });
    expect(resolveLiveScopes).not.toHaveBeenCalled();
  });

  it("refuses a token the surface no longer recognizes as revoked", async () => {
    const resolver = makeMcpDelegationAuthResolver({
      surface: "control-plane-api",
      secret: SECRET,
      replayGuard: memoryReplayGuard(),
      resolvePersonalAccessToken: async () => null,
    });
    await expect(resolver(await patRequest())).resolves.toMatchObject({
      ok: false,
      reason: "CREDENTIAL_REVOKED",
      error: { code: "CREDENTIAL_REVOKED" },
    });
  });

  it("fails loud when a PAT delegation reaches a Worker without a PAT resolver", async () => {
    const resolver = makeMcpDelegationAuthResolver({
      surface: "control-plane-api",
      secret: SECRET,
      replayGuard: memoryReplayGuard(),
      resolveLiveScopes: async () => [],
    });
    await expect(resolver(await patRequest())).rejects.toThrow(
      "worker-runtime: Personal Access Token resolver is required",
    );
  });
});

describe("narrowPersonalAccessTokenForRoute", () => {
  const readOnly = patPrincipal();
  const writer = patPrincipal({ write: { scopes: ["app:app_one:member"], all: false } });

  it("refuses every mutating registry route except cleanup and proposal-derived reviews", () => {
    const mutations = routeRegistry.filter(
      (route) =>
        route.auth === "control-plane-token" &&
        route.effects.mutates &&
        !["owner-cleanup", "derived"].includes(route.permission),
    );
    for (const route of mutations) {
      const params: Record<string, string> = route.path.includes(":appId")
        ? { appId: "app_one" }
        : route.path.includes(":orgId")
          ? { orgId: "org_one" }
          : {};
      expect(narrowPersonalAccessTokenForRoute(route, readOnly, params).ok, route.id).toBe(false);
    }
  });

  it("leaves reads, POST reads, derived reviews and non-PAT principals unchanged", () => {
    for (const operation of [
      "flags_list",
      "flags_test_eval",
      "experiment_plan",
      "approval_request_reviews_create",
    ]) {
      expect(narrow(operation, readOnly, { appId: "app_one" })).toEqual({
        ok: true,
        principal: readOnly,
      });
    }
    const plain = { ...readOnly, personalAccessToken: undefined };
    expect(narrow("flags_create", plain, { appId: "app_one" })).toEqual({
      ok: true,
      principal: plain,
    });
  });

  it("names the missing permission and target, including slugs", () => {
    for (const appId of ["app_one", "my-app"]) {
      expect(narrow("flags_create", readOnly, { appId })).toMatchObject({
        ok: false,
        error: {
          code: "FORBIDDEN",
          message: `personal access token needs write permission for app:${appId}`,
        },
      });
    }
    expect(narrow("api_keys_create", writer, { appId: "app_one" })).toMatchObject({
      ok: false,
      error: { message: "personal access token needs credentials permission for app:app_one" },
    });
    expect(narrow("flags_create", writer, { appId: "app_two" })).toMatchObject({ ok: false });
  });

  it("uses the registry permission even when a caller supplies different metadata", () => {
    const registered = getRoute("flags_create");
    if (registered?.auth !== "control-plane-token") throw new Error("missing flags_create route");
    expect(
      narrowPersonalAccessTokenForRoute({ ...registered, permission: "read" }, readOnly, {
        appId: "app_one",
      }),
    ).toMatchObject({
      ok: false,
      error: { message: "personal access token needs write permission for app:app_one" },
    });
  });

  it("requires the declared permission across destructive, credential, membership and privacy routes", () => {
    for (const [operation, permission, params, target] of [
      ["flags_delete", "delete", { appId: "app_one" }, "app:app_one"],
      ["api_keys_create", "credentials", { appId: "app_one" }, "app:app_one"],
      ["organization_members_add", "members", { orgId: "org_one" }, "org:org_one"],
      ["app_privacy_export", "privacy", { appId: "app_one" }, "app:app_one"],
    ] as const) {
      expect(narrow(operation, writer, params)).toMatchObject({
        ok: false,
        error: {
          code: "FORBIDDEN",
          message: `personal access token needs ${permission} permission for ${target}`,
        },
      });
    }
  });

  it("narrows each permission to its own role ceiling", () => {
    const mixed = patPrincipal({
      write: { scopes: ["app:app_one:member"], all: false },
      credentials: { scopes: ["app:app_one:admin"], all: false },
    });
    expect(narrow("flags_create", mixed, { appId: "app_one" })).toMatchObject({
      ok: true,
      principal: { scopes: ["app:app_one:member"], appId: "app_one" },
    });
    expect(narrow("api_keys_create", mixed, { appId: "app_one" })).toMatchObject({
      ok: true,
      principal: { scopes: ["app:app_one:admin"], appId: "app_one" },
    });
  });

  it("requires the operation permission's all grant for pathless operations", () => {
    expect(narrow("organizations_create", writer, {})).toMatchObject({
      ok: false,
      error: { message: "personal access token needs write permission for all" },
    });
    const allWriter = patPrincipal({ write: { scopes: [], all: true } });
    expect(narrow("organizations_create", allWriter, {})).toMatchObject({ ok: true });
    expect(narrow("current_user_privacy_export", allWriter, {})).toMatchObject({
      ok: false,
      error: { message: "personal access token needs privacy permission for all" },
    });
  });

  it("lets read-only tokens perform owner cleanup", () => {
    for (const operation of [
      "personal_access_tokens_list",
      "personal_access_tokens_revoke",
      "personal_access_tokens_revoke_all",
    ]) {
      expect(narrow(operation, readOnly, {})).toEqual({ ok: true, principal: readOnly });
    }
  });

  it("requires a login session for token minting, editing, rotation and account deletion", () => {
    for (const operation of [
      "personal_access_tokens_create",
      "personal_access_tokens_update",
      "personal_access_tokens_rotate",
      "current_user_delete",
    ]) {
      expect(narrow(operation, writer, {})).toMatchObject({
        ok: false,
        error: {
          code: "FORBIDDEN",
          message: expect.stringContaining("a login session is required; run splitch login"),
        },
      });
    }
  });

  it("fails closed for an unregistered operation even with permission scopes", () => {
    const contract = { id: "not_a_route", path: "/apps/:appId/x" } as unknown as RouteContract;
    expect(narrowPersonalAccessTokenForRoute(contract, writer, { appId: "app_one" })).toMatchObject(
      { ok: false },
    );
  });
});

function narrow(operationId: string, principal: Principal, params: Record<string, string>) {
  const route = getRoute(operationId);
  if (!route) throw new Error(`missing route ${operationId}`);
  return narrowPersonalAccessTokenForRoute(route, principal, params);
}

function patPrincipal(
  overrides: Partial<PersonalAccessTokenAuthority["permissions"]> = {},
): Principal {
  return {
    kind: "control-plane-token",
    id: "user_one",
    scopes: ["app:app_one:admin", "app:app_two:admin", "org:org_one:owner"],
    orgId: null,
    appId: null,
    environmentId: null,
    authDoor: "personal_access_token",
    liveMembership: true,
    personalAccessToken: { id: TOKEN_ID, permissions: { ...emptyPermissions(), ...overrides } },
  };
}

function emptyPermissions(): PersonalAccessTokenAuthority["permissions"] {
  return personalAccessTokenAuthority({ organizations: [], apps: [] }, []).permissions;
}

async function patRequest(): Promise<Request> {
  const request = new Request("https://worker.internal/apps/app_one/flags");
  request.headers.set(
    MCP_DELEGATION_HEADER,
    await createMcpDelegationHeader({
      operationId: "flags_list",
      actor: {
        subject: "user_one",
        scopes: [],
        liveMembership: true,
        authDoor: "personal_access_token",
        personalAccessTokenId: TOKEN_ID,
        personalAccessTokenHash: TOKEN_HASH,
      },
      request,
      secret: SECRET,
    }),
  );
  return request;
}

function memoryReplayGuard(): McpDelegationReplayGuard {
  const seen = new Set<string>();
  return {
    async claim(jti) {
      if (seen.has(jti)) return false;
      seen.add(jti);
      return true;
    },
  };
}

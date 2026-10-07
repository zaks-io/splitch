import {
  createMcpDelegationHeader,
  getRoute,
  MCP_DELEGATION_HEADER,
  type McpDelegationReplayGuard,
  type RouteContract,
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
      writeScopes: [],
      writeAll: false,
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
        personalAccessToken: { id: TOKEN_ID, writeScopes: [], writeAll: false },
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
  const readOnly = patPrincipal({
    scopes: ["app:app_one:admin", "org:org_one:admin"],
    writeScopes: [],
    writeAll: false,
  });
  const appWriter = patPrincipal({
    scopes: ["app:app_one:admin", "app:app_two:admin"],
    writeScopes: ["app:app_one:member"],
    writeAll: false,
  });

  it("leaves non-PAT principals and non-mutating operations untouched", () => {
    const plain = { ...readOnly, personalAccessToken: undefined };
    expect(narrow("flags_create", plain, { appId: "app_one" })).toEqual({
      ok: true,
      principal: plain,
    });
    expect(narrow("flags_list", readOnly, { appId: "app_one" })).toEqual({
      ok: true,
      principal: readOnly,
    });
    // A POST whose audited effects write nothing stays readable.
    expect(
      narrow("flags_test_eval", readOnly, {
        appId: "app_one",
        environmentId: "env_one",
        flagKey: "f",
      }),
    ).toEqual({ ok: true, principal: readOnly });
  });

  it("refuses a mutation on a read-only target with an actionable message", () => {
    expect(narrow("flags_create", readOnly, { appId: "app_one" })).toEqual({
      ok: false,
      error: {
        code: "FORBIDDEN",
        message: "personal access token grants read-only access to app:app_one",
        details: {},
      },
    });
    expect(narrow("flags_create", appWriter, { appId: "app_two" })).toMatchObject({
      ok: false,
      error: { message: "personal access token grants read-only access to app:app_two" },
    });
  });

  it("narrows a permitted mutation to the write scopes so role checks see the write ceiling", () => {
    expect(narrow("flags_create", appWriter, { appId: "app_one" })).toEqual({
      ok: true,
      principal: {
        ...appWriter,
        scopes: ["app:app_one:member"],
        orgId: null,
        appId: "app_one",
      },
    });
  });

  it("requires a read-write `all` grant for a mutation with no Org or App in its path", () => {
    expect(narrow("organizations_create", appWriter, {})).toMatchObject({
      ok: false,
      error: {
        code: "FORBIDDEN",
        message: "personal access token needs a read-write `all` grant for this operation",
      },
    });
    const allWriter = patPrincipal({ scopes: [], writeScopes: [], writeAll: true });
    expect(narrow("organizations_create", allWriter, {})).toMatchObject({ ok: true });
  });

  it("treats an operation missing from the registry as mutating", () => {
    const contract = { id: "not_a_route", path: "/apps/:appId/x" } as unknown as RouteContract;
    expect(
      narrowPersonalAccessTokenForRoute(contract, readOnly, { appId: "app_one" }),
    ).toMatchObject({ ok: false });
  });
});

function narrow(operationId: string, principal: Principal, params: Record<string, string>) {
  const route = getRoute(operationId);
  if (!route) throw new Error(`missing route ${operationId}`);
  return narrowPersonalAccessTokenForRoute(
    { id: route.operationId, path: route.path, method: route.method } as unknown as RouteContract,
    principal,
    params,
  );
}

function patPrincipal(authority: {
  scopes: string[];
  writeScopes: string[];
  writeAll: boolean;
}): Principal {
  return {
    kind: "control-plane-token",
    id: "user_one",
    scopes: authority.scopes,
    orgId: null,
    appId: null,
    environmentId: null,
    authDoor: "personal_access_token",
    liveMembership: true,
    personalAccessToken: {
      id: TOKEN_ID,
      writeScopes: authority.writeScopes,
      writeAll: authority.writeAll,
    },
  };
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

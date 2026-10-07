import {
  MCP_DELEGATION_HEADER,
  type PersonalAccessTokenCache,
  parseMcpDelegation,
  personalAccessTokenCacheKey,
} from "@splitch/contracts";
import { describe, expect, it, vi } from "vitest";
import { flagPage } from "./mcp-flag-fixtures";
import { handleMcpServerRequest } from "./mcp-handler";
import { verifyPersonalAccessToken } from "./mcp-personal-access-token";
import { memoryMcpDelegationReplayGuard, TEST_MCP_DELEGATION_SECRET } from "./mcp-test-verifier";

const SECRET = `spl_pat_${"c".repeat(64)}`;
const TOKEN_ID = `pat_${"b".repeat(32)}`;
const NOW_MS = Date.UTC(2026, 9, 3, 12, 0, 0);

async function hashHex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function storeWith(entry: Partial<PersonalAccessTokenCache> | null) {
  const values = new Map<string, string>();
  if (entry) {
    values.set(
      personalAccessTokenCacheKey(await hashHex(SECRET)),
      JSON.stringify({
        version: 1,
        tokenId: TOKEN_ID,
        userId: "user_pat_owner",
        createdAt: "2026-10-01T00:00:00.000Z",
        expiresAt: null,
        revoked: false,
        ...entry,
      }),
    );
  }
  return {
    get: vi.fn(async (key: string) => values.get(key) ?? null),
  } as unknown as Pick<KVNamespace, "get"> & { get: ReturnType<typeof vi.fn> };
}

describe("verifyPersonalAccessToken", () => {
  it("authenticates an active token as a live-membership PAT actor", async () => {
    await expect(
      verifyPersonalAccessToken(await storeWith({}), `Bearer ${SECRET}`, NOW_MS),
    ).resolves.toEqual({
      ok: true,
      actor: {
        subject: "user_pat_owner",
        scopes: [],
        liveMembership: true,
        authDoor: "personal_access_token",
        personalAccessTokenId: TOKEN_ID,
        personalAccessTokenHash: await hashHex(SECRET),
      },
    });
  });

  it("explains every refusal so an agent knows what to do next", async () => {
    const cases: [Partial<PersonalAccessTokenCache> | null, string, RegExp][] = [
      [null, `Bearer ${SECRET}`, /unknown/],
      [{ revoked: true }, `Bearer ${SECRET}`, /revoked or rotated/],
      [{ expiresAt: "2026-10-02T00:00:00.000Z" }, `Bearer ${SECRET}`, /expired/],
      [{}, "Bearer spl_pat_short", /malformed/],
    ];
    for (const [entry, authorization, description] of cases) {
      const result = await verifyPersonalAccessToken(await storeWith(entry), authorization, NOW_MS);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.description).toMatch(description);
    }
  });
});

describe("MCP request with a Personal Access Token", () => {
  function request(authorization: string, method = "tools/call", params?: unknown): Request {
    return new Request("https://mcp.test/mcp", {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
  }

  it("delegates a tool call carrying the token id, without consulting the JWT verifier or session revocation", async () => {
    const delegated: Request[] = [];
    const tokenVerifier = { verify: vi.fn(async () => null) };
    const revocations = { isRevoked: vi.fn(async () => true) };
    const response = await handleMcpServerRequest({
      request: request(`Bearer ${SECRET}`, "tools/call", {
        name: "flags_list",
        arguments: { appId: "app_local" },
      }),
      service: "splitch-mcp-server",
      platformTarget: "local",
      tokenVerifier,
      revocations,
      personalAccessTokens: await storeWith({}),
      controlPlaneDelegationSecret: TEST_MCP_DELEGATION_SECRET,
      controlPlaneBaseUrl: "https://cp.internal",
      controlPlaneFetch: async (input, init) => {
        delegated.push(new Request(input, init));
        return Response.json(flagPage);
      },
      now: () => NOW_MS,
    });

    expect(response.status).toBe(200);
    expect(tokenVerifier.verify).not.toHaveBeenCalled();
    expect(revocations.isRevoked).not.toHaveBeenCalled();
    expect(delegated).toHaveLength(1);
    const sent = delegated[0] as Request;
    // The secret never leaves the MCP Worker; only the signed token id does.
    expect(sent.headers.get("authorization")).toBeNull();
    expect(JSON.stringify([...sent.headers])).not.toContain(SECRET);
    await expect(
      parseMcpDelegation({
        request: sent,
        surface: "control-plane-api",
        secret: TEST_MCP_DELEGATION_SECRET,
        replayGuard: memoryMcpDelegationReplayGuard(),
      }),
    ).resolves.toMatchObject({
      subject: "user_pat_owner",
      authDoor: "personal_access_token",
      personalAccessTokenId: TOKEN_ID,
      personalAccessTokenHash: await hashHex(SECRET),
    });
    expect(sent.headers.has(MCP_DELEGATION_HEADER)).toBe(true);
  });

  it("answers a revoked token with a 401 that says why", async () => {
    const response = await handleMcpServerRequest({
      request: request(`Bearer ${SECRET}`, "tools/list"),
      service: "splitch-mcp-server",
      platformTarget: "local",
      tokenVerifier: { verify: async () => null },
      revocations: { isRevoked: async () => false },
      personalAccessTokens: await storeWith({ revoked: true }),
      now: () => NOW_MS,
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain('error="invalid_token"');
    expect(response.headers.get("www-authenticate")).toContain("revoked or rotated");
    expect(await response.text()).toMatch(/^Unauthorized: personal access token was revoked/);
  });
});

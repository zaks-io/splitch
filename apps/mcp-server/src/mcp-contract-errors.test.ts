import { type ErrorResponse, parseMcpDelegation } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { handleMcpServerRequest } from "./mcp-handler";
import {
  allowMcpRevocations,
  memoryMcpDelegationReplayGuard,
  TEST_MCP_DELEGATION_SECRET,
} from "./mcp-test-verifier";

const service = "splitch-mcp-server";

// Imported at module scope so the cold transform of the entire
// control-plane-api module graph lands in collection, not inside a test's
// timeout budget (it blew the 5s default under a CPU-contended full run).
const controlPlaneAppModule = (await import(
  new URL("../../control-plane-api/src/app.ts", import.meta.url).href
)) as {
  createApp(deps: unknown): { fetch(request: Request): Promise<Response> };
};

describe("MCP contract errors", () => {
  it("keeps unauthorized organization and privacy errors typed", async () => {
    const seen: Request[] = [];
    const controlPlaneFetch: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      seen.push(request);
      return Response.json(
        { code: "UNAUTHORIZED", message: "authentication required", details: {} },
        { status: 401 },
      );
    };

    const orgs = await callTool("organizations_list", controlPlaneFetch);
    const privacy = await callTool("current_user_privacy_export", controlPlaneFetch);

    expect(seen.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
      "GET /orgs",
      "POST /users/me/privacy/export",
    ]);
    expect(orgs.result).toMatchObject({
      isError: true,
      structuredContent: { code: "UNAUTHORIZED" satisfies ErrorResponse["code"] },
    });
    expect(privacy.result).toMatchObject({
      isError: true,
      structuredContent: { code: "UNAUTHORIZED" satisfies ErrorResponse["code"] },
    });
  });

  describe("returns the real Control Plane authorization result for privacy request status", () => {
    const arguments_ = { requestId: "privacy_request_mcp_contract" };

    it.each([
      "Bearer member",
      "Bearer unrelated",
      "Bearer wrong-org-scope",
      "Bearer wrong-app-scope",
    ])("%s is FORBIDDEN", async (authorization) => {
      const result = await callTool(
        "privacy_requests_get",
        realControlPlaneFetch(),
        arguments_,
        authorization,
      );
      expect(result.result).toMatchObject({
        isError: true,
        structuredContent: { code: "FORBIDDEN" satisfies ErrorResponse["code"] },
      });
    });

    it.each([
      "Bearer requester",
      "Bearer org-owner",
      "Bearer app-admin",
    ])("%s is authorized and surfaces SERVICE_UNAVAILABLE", async (authorization) => {
      const result = await callTool(
        "privacy_requests_get",
        realControlPlaneFetch(),
        arguments_,
        authorization,
      );
      expect(result.result).toMatchObject({
        isError: true,
        structuredContent: { code: "SERVICE_UNAVAILABLE" satisfies ErrorResponse["code"] },
      });
    });
  });
});

async function callTool(
  name: string,
  controlPlaneFetch: typeof fetch,
  arguments_: Record<string, unknown> = {},
  authorization = "Bearer invalid-control-plane-token",
): Promise<ToolCallResult> {
  const response = await handleMcpServerRequest({
    request: new Request("https://mcp.test/mcp", {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: arguments_ },
      }),
    }),
    service,
    controlPlaneBaseUrl: "https://control-plane.test",
    controlPlaneFetch,
    controlPlaneDelegationSecret: TEST_MCP_DELEGATION_SECRET,
    tokenVerifier: {
      async verify() {
        const principal = principalFor(authorization);
        return principal.ok
          ? {
              subject: principal.principal.id,
              scopes: [...principal.principal.scopes],
              authDoor: "id_jag" as const,
            }
          : { subject: "invalid-test-actor", scopes: [], authDoor: "id_jag" as const };
      },
    },
    revocations: allowMcpRevocations(),
  });
  return (await response.json()) as ToolCallResult;
}

function realControlPlaneFetch(): typeof fetch {
  const replayGuard = memoryMcpDelegationReplayGuard();
  const app = controlPlaneAppModule.createApp({
    authResolver: async (request: Request) => {
      const actor = await parseMcpDelegation({
        request,
        surface: "control-plane-api",
        secret: TEST_MCP_DELEGATION_SECRET,
        replayGuard,
      });
      if (!actor) return { ok: false as const, reason: "UNAUTHORIZED" as const };
      return {
        ok: true as const,
        principal: {
          kind: "control-plane-token" as const,
          id: actor.subject,
          scopes: actor.scopes,
          orgId: soleScopedId(actor.scopes, "org"),
          appId: soleScopedId(actor.scopes, "app"),
          environmentId: null,
        },
      };
    },
    rateLimiter: () => ({ limited: false }),
    repo: {
      identity: {
        getOrgMembership: async (orgId: string, userId: string) =>
          orgId === "org_mcp_contract" && userId === "org-owner" ? { role: "owner" } : null,
        getAppMembership: async (scope: { appId: string }, userId: string) =>
          scope.appId === "app_mcp_contract" && userId === "app-admin" ? { role: "admin" } : null,
      },
      privacy: {
        getPrivacyRequestById: async (requestId: string) =>
          requestId === "privacy_request_mcp_contract"
            ? {
                orgId: "org_mcp_contract",
                appId: "app_mcp_contract",
                requestedBy: "requester",
              }
            : null,
      },
    },
  });
  return async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    return app.fetch(request);
  };
}

function soleScopedId(scopes: readonly string[], kind: "org" | "app"): string | null {
  const ids = new Set(
    scopes.flatMap((scope) => {
      const match = scope.match(new RegExp(`^${kind}:([^:]+):(owner|admin|member)$`));
      return match?.[1] ? [match[1]] : [];
    }),
  );
  return ids.size === 1 ? ([...ids][0] as string) : null;
}

function principalFor(authorization: string | null) {
  const principals = {
    "Bearer requester": { id: "requester", scopes: [], orgId: null, appId: null },
    "Bearer member": {
      id: "member",
      scopes: ["org:org_mcp_contract:member"],
      orgId: "org_mcp_contract",
      appId: null,
    },
    "Bearer unrelated": {
      id: "unrelated",
      scopes: ["org:org_mcp_contract:owner"],
      orgId: "org_mcp_contract",
      appId: null,
    },
    "Bearer wrong-org-scope": {
      id: "org-owner",
      scopes: ["org:org_other:owner"],
      orgId: "org_other",
      appId: null,
    },
    "Bearer org-owner": {
      id: "org-owner",
      scopes: ["org:org_mcp_contract:owner"],
      orgId: "org_mcp_contract",
      appId: null,
    },
    "Bearer wrong-app-scope": {
      id: "app-admin",
      scopes: ["app:app_other:admin"],
      orgId: null,
      appId: "app_other",
    },
    "Bearer app-admin": {
      id: "app-admin",
      scopes: ["app:app_mcp_contract:admin"],
      orgId: null,
      appId: "app_mcp_contract",
    },
  } as const;
  const principal = authorization
    ? principals[authorization as keyof typeof principals]
    : undefined;
  return principal
    ? {
        ok: true as const,
        principal: {
          ...principal,
          kind: "control-plane-token" as const,
          environmentId: null,
        },
      }
    : { ok: false as const, reason: "UNAUTHORIZED" as const };
}

interface ToolCallResult {
  result: {
    isError?: boolean;
    structuredContent: ErrorResponse;
  };
}

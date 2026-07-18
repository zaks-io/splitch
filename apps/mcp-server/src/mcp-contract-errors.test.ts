import type { ErrorResponse } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { handleMcpServerRequest } from "./mcp-handler";

const service = "splitch-mcp-server";

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

  it("returns the real Control Plane authorization result for privacy request status", async () => {
    const controlPlaneFetch = await realControlPlaneFetch();
    const arguments_ = { requestId: "privacy_request_mcp_contract" };

    for (const authorization of [
      "Bearer member",
      "Bearer unrelated",
      "Bearer wrong-org-scope",
      "Bearer wrong-app-scope",
    ]) {
      const result = await callTool(
        "privacy_requests_get",
        controlPlaneFetch,
        arguments_,
        authorization,
      );
      expect(result.result).toMatchObject({
        isError: true,
        structuredContent: { code: "FORBIDDEN" satisfies ErrorResponse["code"] },
      });
    }

    for (const authorization of ["Bearer requester", "Bearer org-owner", "Bearer app-admin"]) {
      const result = await callTool(
        "privacy_requests_get",
        controlPlaneFetch,
        arguments_,
        authorization,
      );
      expect(result.result).toMatchObject({
        isError: true,
        structuredContent: { code: "SERVICE_UNAVAILABLE" satisfies ErrorResponse["code"] },
      });
    }
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
  });
  return (await response.json()) as ToolCallResult;
}

async function realControlPlaneFetch(): Promise<typeof fetch> {
  const module = (await import(
    new URL("../../control-plane-api/src/app.ts", import.meta.url).href
  )) as {
    createApp(deps: unknown): { fetch(request: Request): Promise<Response> };
  };
  const app = module.createApp({
    authResolver: async (request: Request) => principalFor(request.headers.get("authorization")),
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

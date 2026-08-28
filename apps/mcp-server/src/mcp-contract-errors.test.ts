import { type ErrorResponse, unavailableControlPlaneOperationIds } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { handleMcpServerRequest } from "./mcp-handler";
import { allowMcpRevocations, TEST_MCP_DELEGATION_SECRET } from "./mcp-test-verifier";

const service = "splitch-mcp-server";

describe("MCP contract errors", () => {
  it("keeps unauthorized organization errors typed", async () => {
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

    expect(seen.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
      "GET /orgs",
    ]);
    expect(orgs.result).toMatchObject({
      isError: true,
      structuredContent: { code: "UNAUTHORIZED" satisfies ErrorResponse["code"] },
    });
  });

  it.each(
    unavailableControlPlaneOperationIds,
  )("does not advertise or dispatch %s", async (name) => {
    let forwarded = false;
    const result = await callTool(name, async () => {
      forwarded = true;
      return Response.json({});
    });

    expect(forwarded).toBe(false);
    expect(result.error).toMatchObject({ code: -32601, message: "Method not found" });
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
    platformTarget: "local",
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
  result?: {
    isError?: boolean;
    structuredContent: ErrorResponse;
  };
  error?: { code: number; message: string };
}

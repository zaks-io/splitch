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

  it("keeps member and unrelated-principal authorization errors typed", async () => {
    const controlPlaneFetch: typeof fetch = async () =>
      Response.json(
        {
          code: "FORBIDDEN",
          message: "credential is not allowed for this operation",
          details: {},
        },
        { status: 403 },
      );
    const inputs = [
      ["organizations_delete", { orgId: "org_forbidden" }],
      ["organization_privacy_export", { orgId: "org_forbidden" }],
      ["app_privacy_export", { appId: "app_forbidden" }],
      [
        "entity_privacy_export",
        { appId: "app_forbidden", idType: "user", targetingKey: "subject_forbidden" },
      ],
      [
        "entity_privacy_delete",
        { appId: "app_forbidden", idType: "user", targetingKey: "subject_forbidden" },
      ],
      ["privacy_requests_get", { requestId: "privacy_request_forbidden" }],
    ] as const;

    for (const _principal of ["member", "unrelated"]) {
      for (const [name, arguments_] of inputs) {
        const result = await callTool(name, controlPlaneFetch, arguments_);
        expect(result.result).toMatchObject({
          isError: true,
          structuredContent: { code: "FORBIDDEN" satisfies ErrorResponse["code"] },
        });
      }
    }
  });
});

async function callTool(
  name: string,
  controlPlaneFetch: typeof fetch,
  arguments_: Record<string, unknown> = {},
): Promise<ToolCallResult> {
  const response = await handleMcpServerRequest({
    request: new Request("https://mcp.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
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

interface ToolCallResult {
  result: {
    isError?: boolean;
    structuredContent: ErrorResponse;
  };
}

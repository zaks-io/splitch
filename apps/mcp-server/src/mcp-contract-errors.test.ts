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
});

async function callTool(name: string, controlPlaneFetch: typeof fetch): Promise<ToolCallResult> {
  const response = await handleMcpServerRequest({
    request: new Request("https://mcp.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: {} },
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

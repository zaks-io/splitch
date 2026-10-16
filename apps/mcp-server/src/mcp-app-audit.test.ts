import { getRouteMembershipGate } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { handleMcpServerRequest } from "./mcp-handler";
import {
  allowMcpRevocations,
  staticMcpTokenVerifier,
  TEST_MCP_DELEGATION_SECRET,
} from "./mcp-test-verifier";

describe("App audit MCP parity", () => {
  it("requires App admin and calls only Control Plane with the shared list envelope", async () => {
    const seen: Request[] = [];
    const data = { items: [], readLimit: 2, readTruncated: false, cursor: null };
    const response = await handleMcpServerRequest({
      request: new Request("https://mcp.test/mcp", {
        method: "POST",
        headers: { authorization: "Bearer fixture", "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "app_audit_list",
            arguments: { appId: "app_local", limit: 2, runId: "run_1" },
          },
        }),
      }),
      service: "splitch-mcp-server",
      platformTarget: "local",
      controlPlaneBaseUrl: "http://control-plane.test",
      controlPlaneFetch: async (input, init) => {
        seen.push(new Request(input, init));
        return Response.json(data);
      },
      controlPlaneDelegationSecret: TEST_MCP_DELEGATION_SECRET,
      tokenVerifier: staticMcpTokenVerifier(),
      revocations: allowMcpRevocations(),
    });
    expect(getRouteMembershipGate("app_audit_list")).toEqual({ axis: "app", minimumRole: "admin" });
    expect(seen.map((request) => request.url)).toEqual([
      "http://control-plane.test/apps/app_local/audit?limit=2&runId=run_1",
    ]);
    const body = (await response.json()) as {
      result: { structuredContent: unknown; isError?: boolean };
    };
    expect(body.result.isError).toBeUndefined();
    expect(body.result.structuredContent).toEqual(data);
  });
});

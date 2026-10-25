import { expect, it, vi } from "vitest";
import { handleMcpServerRequest } from "./mcp-handler";
import {
  allowMcpRevocations,
  staticMcpTokenVerifier,
  TEST_MCP_DELEGATION_SECRET,
} from "./mcp-test-verifier";

const SUMMARY = {
  appId: "app_1",
  environmentId: "env_1",
  wake: "scheduled",
  providers: {
    convex: { pendingCount: 2, leasedCount: 1, oldestOutstandingAgeMs: 120_000 },
    cloudflare: { pendingCount: 0, leasedCount: 0, oldestOutstandingAgeMs: null },
  },
};

it("calls the Environment delivery operation and returns the full structured summary", async () => {
  const controlPlaneFetch = vi.fn<typeof fetch>(async (input, init) => {
    const request = new Request(input, init);
    expect(request.method).toBe("POST");
    expect(request.url).toMatch(/\/apps\/app_1\/envs\/env_1\/integrations\/deliveries$/);
    return Response.json(SUMMARY);
  });
  const response = await handleMcpServerRequest({
    request: new Request("https://mcp.test/mcp", {
      method: "POST",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "integration_deliveries_create",
          arguments: { appId: "app_1", environmentId: "env_1" },
        },
      }),
    }),
    service: "splitch-mcp-server",
    platformTarget: "local",
    controlPlaneFetch,
    controlPlaneDelegationSecret: TEST_MCP_DELEGATION_SECRET,
    tokenVerifier: staticMcpTokenVerifier({
      subject: "user_test",
      scopes: ["app:app_1:admin"],
      authDoor: "id_jag",
    }),
    revocations: allowMcpRevocations(),
  });
  const body = (await response.json()) as { result: { structuredContent: unknown } };
  expect(body).toMatchObject({ result: { structuredContent: SUMMARY } });
  expect(controlPlaneFetch).toHaveBeenCalledOnce();
});

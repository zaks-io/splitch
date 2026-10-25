import { describe, expect, it } from "vitest";
import { handleMcpServerRequest } from "./mcp-handler";
import {
  allowMcpRevocations,
  staticMcpTokenVerifier,
  TEST_MCP_DELEGATION_SECRET,
} from "./mcp-test-verifier";

const MISSING_AT = "2026-10-25T08:00:00.000Z";
const PAGE = {
  items: [
    {
      installationId: "00000000-0000-4000-8000-000000000001",
      appId: "app_local",
      environmentId: "env_local",
      environmentVersion: 7,
      status: "active",
      deploymentMissingAt: MISSING_AT,
      callbackUrl: "https://example.convex.site/configuration",
      lastDeliveredVersion: 6,
      lastDeliveredAt: null,
      pendingCount: 0,
      oldestPendingAgeMs: null,
      terminalCount: 1,
      latestDeliveryError: null,
    },
  ],
  readLimit: 200,
  readTruncated: false,
  cursor: null,
};

describe("Convex installation MCP health", () => {
  it("returns the dormant timestamp in structured and text output", async () => {
    const response = await handleMcpServerRequest({
      request: new Request("https://mcp.test/mcp", {
        method: "POST",
        headers: { authorization: "Bearer test", "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "convex_installations_list",
            arguments: { appId: "app_local", environmentId: "env_local" },
          },
        }),
      }),
      service: "splitch-mcp-server",
      platformTarget: "local",
      controlPlaneFetch: async () => Response.json(PAGE),
      controlPlaneDelegationSecret: TEST_MCP_DELEGATION_SECRET,
      tokenVerifier: staticMcpTokenVerifier(),
      revocations: allowMcpRevocations(),
    });
    const body = (await response.json()) as {
      result: { content: Array<{ type: string; text: string }>; structuredContent: unknown };
    };
    expect(body).toMatchObject({
      result: {
        structuredContent: PAGE,
      },
    });
    expect(JSON.parse(body.result.content[0]?.text ?? "null")).toEqual(PAGE);
  });
});

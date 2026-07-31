import type { ErrorResponse } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { handleMcpServerRequest } from "./mcp-handler";
import { allowMcpRevocations, TEST_MCP_DELEGATION_SECRET } from "./mcp-test-verifier";

/**
 * SPL-266: the client-side refusal must reach the agent in the SAME shape as the
 * Worker's own refusal — a tool result carrying a typed `ErrorResponse` — not as a
 * JSON-RPC `-32603 "Internal error"` with the remedy buried in prose. An agent that
 * branches on `code` has to keep working when the check moves closer to the caller.
 */

const service = "splitch-mcp-server";

describe("mcp missing-idempotency-key refusal", () => {
  it("returns a typed VALIDATION_ERROR tool result and issues no upstream request", async () => {
    const seen: Request[] = [];
    const body = await callTool("flags_delete", { appId: "app_local", flagId: "flag_local" }, seen);

    expect(seen).toEqual([]);
    expect(body.error).toBeUndefined();
    expect(body.result?.isError).toBe(true);
    expect(body.result?.structuredContent).toMatchObject({
      code: "VALIDATION_ERROR" satisfies ErrorResponse["code"],
    });
    expect(body.result?.structuredContent?.message).toContain("idempotency_key");
    expect(body.result?.structuredContent?.details).toMatchObject({
      issues: [expect.objectContaining({ path: ["idempotency_key"] })],
    });
  });

  it("still returns JSON-RPC Internal error for a genuinely unexpected throw", async () => {
    const body = await callTool(
      "flags_delete",
      { appId: "app_local", flagId: "flag_local", idempotency_key: "idem_1" },
      [],
      () => {
        throw new Error("upstream exploded");
      },
    );

    expect(body.result).toBeUndefined();
    expect(body.error).toMatchObject({ code: -32603, message: "Internal error" });
  });
});

interface ToolCallBody {
  result?: { isError?: boolean; structuredContent?: ErrorResponse };
  error?: { code: number; message: string; data?: { message?: string } };
}

async function callTool(
  name: string,
  arguments_: Record<string, unknown>,
  seen: Request[],
  onRequest?: (request: Request) => Response,
): Promise<ToolCallBody> {
  const response = await handleMcpServerRequest({
    request: new Request("https://mcp.test/mcp", {
      method: "POST",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: arguments_ },
      }),
    }),
    service,
    controlPlaneBaseUrl: "https://control-plane.test",
    controlPlaneFetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      seen.push(request);
      return onRequest ? onRequest(request) : Response.json({ deleted: true });
    },
    controlPlaneDelegationSecret: TEST_MCP_DELEGATION_SECRET,
    tokenVerifier: {
      async verify() {
        return { subject: "agent", scopes: ["app:app_local:admin"], authDoor: "id_jag" as const };
      },
    },
    revocations: allowMcpRevocations(),
  });
  return (await response.json()) as ToolCallBody;
}

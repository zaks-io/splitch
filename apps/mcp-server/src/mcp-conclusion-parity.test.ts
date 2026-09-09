import { describe, expect, it } from "vitest";
import { handleMcpServerRequest } from "./mcp-handler";
import { allowMcpRevocations, TEST_MCP_DELEGATION_SECRET } from "./mcp-test-verifier";

const APP = "app_local";
const ENV = "env_local";
const EXPERIMENT = "exp_local";
const RUN = "run_local";

describe("MCP Experiment conclusion parity", () => {
  it("dispatches runs_conclude with the strict body and mirrored idempotency header", async () => {
    const { request } = await callTool("runs_conclude", {
      appId: APP,
      environmentId: ENV,
      experimentId: EXPERIMENT,
      runId: RUN,
      selectedVariant: "treatment",
      expectedResultToken: `sha256:${"a".repeat(64)}`,
      dataWatermark: "2026-09-08T12:00:00.000Z",
      target: {
        environmentId: "env_target",
        flagId: "flag_local",
        expectedConfigVersion: 4,
        proposedConfig: {
          enabled: true,
          availableVariantNames: ["control", "treatment"],
          targetingRules: [],
          rollout: { percentage: 100 },
        },
      },
      review: { action: "approve_and_apply" },
      idempotencyKey: "mcp-conclude-run-1",
    });

    expect(new URL(request.url).pathname).toBe(
      `/apps/${APP}/envs/${ENV}/experiments/${EXPERIMENT}/runs/${RUN}/conclusions`,
    );
    expect(request.headers.get("idempotency-key")).toBe("mcp-conclude-run-1");
    expect(await request.json()).toMatchObject({
      selectedVariant: "treatment",
      idempotencyKey: "mcp-conclude-run-1",
    });
  });

  it("dispatches stale Promotion replacement from the named conclusion", async () => {
    const { request } = await callTool("conclusion_promotion_requests_create", {
      appId: APP,
      environmentId: ENV,
      experimentId: EXPERIMENT,
      runId: RUN,
      conclusionId: "conclusion_local",
      expectedConfigVersion: 5,
      review: { action: "approve_and_apply" },
      idempotencyKey: "mcp-replace-promotion-1",
    });

    expect(new URL(request.url).pathname).toBe(
      `/apps/${APP}/envs/${ENV}/experiments/${EXPERIMENT}/runs/${RUN}/conclusions/conclusion_local/promotion-requests`,
    );
    expect(request.headers.get("idempotency-key")).toBe("mcp-replace-promotion-1");
    expect(await request.json()).toEqual({
      expectedConfigVersion: 5,
      review: { action: "approve_and_apply" },
      idempotencyKey: "mcp-replace-promotion-1",
    });
  });
});

async function callTool(
  name: string,
  arguments_: Record<string, unknown>,
): Promise<{ request: Request }> {
  let captured: Request | undefined;
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
    service: "splitch-mcp-server",
    platformTarget: "local",
    controlPlaneBaseUrl: "https://control-plane.test",
    controlPlaneFetch: async (input, init) => {
      captured = input instanceof Request ? input : new Request(input, init);
      return Response.json(
        { code: "RUN_NOT_FOUND", message: "Run not found", details: {} },
        { status: 404 },
      );
    },
    controlPlaneDelegationSecret: TEST_MCP_DELEGATION_SECRET,
    tokenVerifier: {
      async verify() {
        return { subject: "agent", scopes: [`app:${APP}:admin`], authDoor: "id_jag" as const };
      },
    },
    revocations: allowMcpRevocations(),
  });
  const body = (await response.json()) as { result?: { isError?: boolean } };
  expect(body.result?.isError).toBe(true);
  if (!captured) throw new Error("MCP made no Control Plane request");
  return { request: captured };
}

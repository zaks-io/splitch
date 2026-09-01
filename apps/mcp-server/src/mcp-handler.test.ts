import { readFile } from "node:fs/promises";
import { deriveMcpProtocolTools, type ErrorResponse } from "@splitch/contracts";
import { describe, expect, it, vi } from "vitest";
import { flagDefinition, flagPage } from "./mcp-flag-fixtures";
import { handleMcpServerRequest } from "./mcp-handler";
import {
  bootControlPlaneApi,
  type JsonRpcFailure,
  type JsonRpcSuccess,
  mcp,
  type ProtocolTool,
  type SeenRequest,
  service,
  type ToolResult,
  toolsListRequest,
  updatedFlag,
  useMcpServers,
  validationError,
} from "./mcp-handler-harness";
import { staticMcpTokenVerifier, TEST_MCP_DELEGATION_SECRET } from "./mcp-test-verifier";

useMcpServers();

describe("mcp server Streamable HTTP transport", () => {
  it("lists the full S08-derived tool contract", async () => {
    const response = await mcp("tools/list");
    const body = (await response.json()) as JsonRpcSuccess<{ tools: unknown[] }>;

    expect(response.status).toBe(200);
    expect(body.result.tools).toHaveLength(deriveMcpProtocolTools().length + 1);
    expect(body.result.tools).toContainEqual(
      expect.objectContaining({
        name: "flags_list",
        inputSchema: expect.objectContaining({ type: "object" }),
      }),
    );
    expect(body.result.tools).toContainEqual(
      expect.objectContaining({ name: "context_use", inputSchema: expect.any(Object) }),
    );
  });

  it("forwards flags_list through the Control Plane SDK to a local HTTP API", async () => {
    const seen: SeenRequest[] = [];
    const baseUrl = await bootControlPlaneApi(seen);
    const response = await mcp(
      "tools/call",
      { name: "flags_list", arguments: { appId: "app_local" } },
      { controlPlaneBaseUrl: baseUrl },
    );
    const body = (await response.json()) as JsonRpcSuccess<ToolResult<typeof flagPage>>;

    expect(seen).toEqual([
      {
        method: "GET",
        path: "/apps/app_local/flags?include=config",
        authorization: null,
        body: "",
      },
    ]);
    expect(body.result.structuredContent).toEqual(flagPage);
    expect(body.result.structuredContent).not.toHaveProperty("unexpectedSecretLikeField");
  });

  it("keeps Environment-scoped flags_list valid and exposes the compact summary", async () => {
    const seen: SeenRequest[] = [];
    const baseUrl = await bootControlPlaneApi(seen);

    const hydrated = await mcp(
      "tools/call",
      { name: "flags_list", arguments: { appId: "app_local", environmentId: "env_dev" } },
      { controlPlaneBaseUrl: baseUrl },
    );
    const summary = await mcp(
      "tools/call",
      {
        name: "flags_list",
        arguments: { appId: "app_local", environmentId: "env_dev", summary: true },
      },
      { controlPlaneBaseUrl: baseUrl },
    );

    expect(seen.map((request) => request.path)).toEqual([
      "/apps/app_local/flags?include=config&envs=env_dev",
      "/apps/app_local/flags?environmentId=env_dev",
    ]);
    expect(await hydrated.json()).toMatchObject({ result: { structuredContent: flagPage } });
    expect(await summary.json()).toMatchObject({
      result: { structuredContent: { items: [flagDefinition] } },
    });
  });

  it("returns a coded actionable error when a hydrated Flag response is missing Configurations", async () => {
    const seen: SeenRequest[] = [];
    const baseUrl = await bootControlPlaneApi(seen);
    const response = await mcp(
      "tools/call",
      { name: "flags_list", arguments: { appId: "app_unhydrated" } },
      { controlPlaneBaseUrl: baseUrl },
    );
    const body = (await response.json()) as JsonRpcSuccess<ToolResult<Record<string, unknown>>>;

    expect(body.result).toMatchObject({
      isError: true,
      structuredContent: {
        code: "INTERNAL_SERVER_ERROR",
        remediation: expect.stringContaining("Update the server"),
        recommendedAction: "UPDATE_SERVER",
        docsUrl: "https://splitch.dev/docs/error/INTERNAL_SERVER_ERROR",
        details: { fault: "FLAG_READ_CONTRACT_MISMATCH" },
      },
    });
  });

  it("advertises and forwards flags_update with path params and body fields", async () => {
    const listResponse = await mcp("tools/list");
    const listBody = (await listResponse.json()) as JsonRpcSuccess<{ tools: ProtocolTool[] }>;
    const updateTool = listBody.result.tools.find((tool) => tool.name === "flags_update");

    expect(updateTool?.inputSchema).toMatchObject({
      properties: expect.objectContaining({
        appId: expect.any(Object),
        flagId: expect.any(Object),
        name: expect.any(Object),
        description: expect.any(Object),
      }),
      required: expect.arrayContaining(["flagId"]),
    });
    expect(updateTool?.inputSchema.required).not.toContain("appId");

    const seen: SeenRequest[] = [];
    const baseUrl = await bootControlPlaneApi(seen);
    const response = await mcp(
      "tools/call",
      {
        name: "flags_update",
        arguments: {
          appId: "app_local",
          flagId: "flag_checkout",
          name: "Checkout v2",
          description: "Updated checkout",
        },
      },
      { controlPlaneBaseUrl: baseUrl },
    );
    const body = (await response.json()) as JsonRpcSuccess<ToolResult<typeof updatedFlag>>;

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      method: "PATCH",
      path: "/apps/app_local/flags/flag_checkout",
      authorization: null,
    });
    expect(JSON.parse(seen[0]?.body ?? "{}")).toEqual({
      name: "Checkout v2",
      description: "Updated checkout",
    });
    expect(body.result.structuredContent).toEqual(updatedFlag);
  });
});

describe("mcp server errors and config", () => {
  it("fails closed when shared revocation state is missing or unavailable", async () => {
    const options = {
      service,
      platformTarget: "local",
      tokenVerifier: staticMcpTokenVerifier(),
      controlPlaneDelegationSecret: TEST_MCP_DELEGATION_SECRET,
    };

    await expect(
      handleMcpServerRequest({ ...options, request: toolsListRequest() }),
    ).rejects.toThrow("mcp-server: SESSION_STORE revocation binding is required");
    await expect(
      handleMcpServerRequest({
        ...options,
        request: toolsListRequest(),
        revocations: {
          isRevoked: async () => {
            throw new Error("revocation KV unavailable");
          },
        },
      }),
    ).rejects.toThrow("revocation KV unavailable");
  });

  it("fails closed without a local named service binding instead of using public HTTP", async () => {
    const logged: unknown[][] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });
    const response = await mcp("tools/call", {
      name: "flags_list",
      arguments: { appId: "app_local" },
    });
    const body = (await response.json()) as JsonRpcFailure & {
      error: { code: number; message: string; data?: { message?: string; reference?: string } };
    };

    expect(body.error).toMatchObject({ code: -32603 });
    // Loud where an operator reads it, opaque where the agent does.
    expect(JSON.stringify(logged[0]?.[0])).toContain(
      "CONTROL_PLANE_API service binding is required",
    );
    expect(body.error.data?.message).not.toContain("CONTROL_PLANE_API");
    expect(body.error.data?.reference).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("returns MCP method-not-found for an unknown tool name", async () => {
    const response = await mcp("tools/call", { name: "missing_tool", arguments: {} });
    const body = (await response.json()) as JsonRpcFailure;

    expect(response.status).toBe(200);
    expect(body.error).toMatchObject({ code: -32601, message: "Method not found" });
  });

  it("returns upstream ErrorResponse as a tool error when the Worker rejects Zod body", async () => {
    const seen: SeenRequest[] = [];
    const baseUrl = await bootControlPlaneApi(seen);
    // Valid idempotency key, deliberately invalid `variants`: the Worker's body
    // rejection is what this asserts, not the adapter's own key check.
    const args = { appId: "app_local", key: "checkout", schema: null, variants: [] };
    const response = await mcp(
      "tools/call",
      { name: "flags_create", arguments: { ...args, idempotency_key: "idem_probe" } },
      { controlPlaneBaseUrl: baseUrl },
    );
    const body = (await response.json()) as JsonRpcSuccess<ToolResult<ErrorResponse>>;

    expect(seen[0]).toMatchObject({ method: "POST", path: "/apps/app_local/flags" });
    expect(body.result.isError).toBe(true);
    expect(body.result.structuredContent).toEqual(validationError);
  });

  it("keeps wrangler state limited to sessions and shared token revocation", async () => {
    const config = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");

    expect(config).not.toMatch(/d1_databases/i);
    expect(config).not.toMatch(/tinybird|analytics_engine_datasets/i);
    expect(config.match(/"name": "MCP_SESSIONS"/g)).toHaveLength(3);
    expect(config.match(/"class_name": "McpSessionDurableObject"/g)).toHaveLength(3);
    expect(config.match(/"binding": "SESSION_STORE"/g)).toHaveLength(3);
  });
});

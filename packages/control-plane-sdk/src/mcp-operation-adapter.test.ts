import { describe, expect, it } from "vitest";
import { createMcpOperationAdapter } from "./mcp-operation-adapter";

const flagPage = {
  items: [
    {
      id: "flag_checkout",
      appId: "app_local",
      key: "checkout",
      name: "Checkout",
      variants: [{ id: "var_on", name: "on", value: true }],
      defaultVariantId: "var_on",
      createdAt: "2026-07-03T00:00:00.000Z",
      updatedAt: "2026-07-03T00:00:00.000Z",
    },
  ],
};

describe("mcp operation adapter", () => {
  it("forwards flags_list by operationId for dynamic MCP tool execution", async () => {
    const adapter = createMcpOperationAdapter({
      baseUrl: "https://control-plane.test",
      fetch: async () =>
        Response.json({
          ...flagPage,
          unexpectedSecretLikeField: "must-not-escape",
        }),
    });

    const result = await adapter.callOperationById("flags_list", { appId: "app_local" });

    expect(result).toEqual({
      ok: true,
      status: 200,
      data: flagPage,
    });
  });

  it("throws for unknown operation ids", async () => {
    const adapter = createMcpOperationAdapter({
      baseUrl: "https://control-plane.test",
    });

    await expect(adapter.callOperationById("missing_tool", {})).rejects.toThrow(
      'control-plane-sdk: unknown operation "missing_tool"',
    );
  });
});

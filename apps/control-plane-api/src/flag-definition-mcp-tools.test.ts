import { deriveMcpTools, getRoute } from "@splitch/contracts";
import { describe, expect, it } from "vitest";

describe("control-plane Flag MCP tool derivation", () => {
  it("derives flag Variant tools from route path/body fields and preserves output parity", () => {
    const tools = deriveMcpTools();
    for (const operationId of [
      "flags_create",
      "flag_variants_create",
      "flag_variants_update",
    ] as const) {
      const route = getRoute(operationId);
      const tool = tools.find((candidate) => candidate.name === operationId);
      expect(route).toBeDefined();
      expect(tool).toBeDefined();
      expect(tool?.outputSchema).toBe(route?.output);
    }

    const createTool = tools.find((candidate) => candidate.name === "flags_create");
    expect(objectShape(createTool?.inputSchema)).toEqual(
      expect.objectContaining({
        appId: expect.any(Object),
        name: expect.any(Object),
        key: expect.any(Object),
        variants: expect.any(Object),
      }),
    );

    const variantCreateTool = tools.find((candidate) => candidate.name === "flag_variants_create");
    expect(objectShape(variantCreateTool?.inputSchema)).toEqual(
      expect.objectContaining({
        appId: expect.any(Object),
        flagId: expect.any(Object),
        name: expect.any(Object),
        value: expect.any(Object),
      }),
    );

    const updateTool = tools.find((candidate) => candidate.name === "flag_variants_update");
    expect(objectShape(updateTool?.inputSchema)).toEqual(
      expect.objectContaining({
        appId: expect.any(Object),
        flagId: expect.any(Object),
        variantName: expect.any(Object),
        name: expect.any(Object),
        value: expect.any(Object),
      }),
    );
    expect(
      updateTool?.inputSchema.safeParse({
        appId: "app_1",
        flagId: "flag_1",
        variantName: "treatment",
        name: "beta",
      }).success,
    ).toBe(true);
    expect(updateTool?.inputSchema.safeParse({ name: "beta" }).success).toBe(false);
  });
});

function objectShape(schema: unknown): Record<string, unknown> {
  return (schema as { shape?: Record<string, unknown> } | undefined)?.shape ?? {};
}

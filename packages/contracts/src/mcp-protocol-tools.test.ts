import { describe, expect, it } from "vitest";
import { deriveMcpProtocolTools } from "./mcp-tools";
import { getRoute } from "./route-registry";
import { mcpReversibilityMeta, mcpToolAnnotations } from "./route-effects";

describe("MCP protocol tool schemas", () => {
  it("makes session-resolved App and Environment path fields optional", () => {
    const tools = deriveMcpProtocolTools();
    const update = tools.find((tool) => tool.name === "flag_config_update");
    const updateRequired = requiredFields(update?.inputSchema);
    expect(updateRequired).toContain("flagId");
    expect(updateRequired).not.toContain("appId");
    expect(updateRequired).not.toContain("environmentId");

    const organization = tools.find((tool) => tool.name === "organizations_get");
    expect(requiredFields(organization?.inputSchema)).toContain("orgId");
  });

  it("derives MCP annotations and reversibility meta from route effects", () => {
    for (const tool of deriveMcpProtocolTools()) {
      const route = getRoute(tool.name);
      if (!route) throw new Error(`missing route ${tool.name}`);
      expect(tool.annotations).toEqual(mcpToolAnnotations(route.effects));
      expect(tool._meta).toEqual(mcpReversibilityMeta(route.effects));
      if (route.effects.mutates) {
        expect(tool.annotations.readOnlyHint).toBe(false);
        expect(tool.annotations.destructiveHint).toBe(route.effects.destructive);
        expect(tool.annotations.idempotentHint).toBe(route.effects.idempotent);
        expect(tool.annotations.openWorldHint).toBe(route.effects.openWorld);
        expect(tool._meta.reversibilityClass).toBe(route.effects.reversibility);
      }
    }
  });
});

function requiredFields(schema: Record<string, unknown> | undefined): string[] {
  return Array.isArray(schema?.required)
    ? schema.required.filter((field): field is string => typeof field === "string")
    : [];
}

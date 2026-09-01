import { describe, expect, it } from "vitest";
import { deriveMcpProtocolTools } from "./mcp-tools";

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
});

function requiredFields(schema: Record<string, unknown> | undefined): string[] {
  return Array.isArray(schema?.required)
    ? schema.required.filter((field): field is string => typeof field === "string")
    : [];
}

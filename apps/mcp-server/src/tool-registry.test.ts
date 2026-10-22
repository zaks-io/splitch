import { describe, expect, it, vi } from "vitest";

vi.mock("@splitch/contracts", async (importOriginal) => {
  const contracts = await importOriginal<typeof import("@splitch/contracts")>();
  return { ...contracts, deriveMcpProtocolTools: vi.fn(contracts.deriveMcpProtocolTools) };
});

import { deriveMcpProtocolTools } from "@splitch/contracts";
import { MCP_TOOL_NAMES, mcpToolDefinitions } from "./tool-registry";

describe("MCP tool registry", () => {
  it("derives JSON schemas only on discovery and reuses them thereafter", () => {
    expect(MCP_TOOL_NAMES.has("context_use")).toBe(true);
    expect(deriveMcpProtocolTools).not.toHaveBeenCalled();

    const definitions = mcpToolDefinitions();
    expect(new Set(definitions.map((tool) => tool.name))).toEqual(MCP_TOOL_NAMES);
    expect(mcpToolDefinitions()).toBe(definitions);
    expect(deriveMcpProtocolTools).toHaveBeenCalledTimes(1);
  });
});

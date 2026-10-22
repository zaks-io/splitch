import { describe, expect, it } from "vitest";
import { deriveMcpProtocolTools, deriveMcpTools } from "./mcp-tools";

describe("MCP schema memoization", () => {
  it("reuses the complete derived schemas on subsequent calls", () => {
    const tools = deriveMcpTools();
    const protocolTools = deriveMcpProtocolTools();

    expect(tools.length).toBeGreaterThan(0);
    expect(protocolTools.length).toBe(tools.length);
    expect(deriveMcpTools()).toBe(tools);
    expect(deriveMcpProtocolTools()).toBe(protocolTools);
    expect(deriveMcpProtocolTools()[0]?.inputSchema).toBe(protocolTools[0]?.inputSchema);
  });
});

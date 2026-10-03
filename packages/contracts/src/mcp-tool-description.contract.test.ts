import { describe, expect, it } from "vitest";
import { z } from "zod";
import { composeMcpToolDescription } from "./mcp-tool-description";
import { assertMcpToolDescriptionContract } from "./mcp-tool-description-contract";
import { deriveMcpTools } from "./mcp-tools";
import { getRoute } from "./route-registry";

const tools = deriveMcpTools();

describe("mcp tool description contract", () => {
  it("fails when a mutating route has no worked arguments example", () => {
    expect(() =>
      assertMcpToolDescriptionContract({
        name: "flags_create",
        description: "Create a Flag.\n\nFormats: no id, timestamp, or enum arguments.",
        mutates: true,
        inputSchema: z.object({ appId: z.string() }),
      }),
    ).toThrow(/mutating route missing Example arguments/);
  });

  it("fails when a description uses a curated glossary term without defining it", () => {
    expect(() =>
      assertMcpToolDescriptionContract({
        name: "flags_list",
        description: "List Flags in an App.\n\nFormats: no id, timestamp, or enum arguments.",
        mutates: false,
        inputSchema: z.object({}),
      }),
    ).toThrow(/undefined glossary term "Flag"/);
  });

  it("every registry-derived MCP tool states formats and defines curated terms it uses", () => {
    for (const tool of tools) {
      const route = getRoute(tool.name);
      if (!route) throw new Error(`missing route ${tool.name}`);
      expect(() =>
        assertMcpToolDescriptionContract({
          name: tool.name,
          description: tool.description,
          mutates: route.effects.mutates,
          inputSchema: tool.inputSchema,
        }),
      ).not.toThrow();
    }
  });

  it("every mutating registry-derived MCP tool carries one parseable arguments example", () => {
    const mutating = tools.filter((tool) => {
      const route = getRoute(tool.name);
      if (!route) throw new Error(`missing route ${tool.name}`);
      return route.effects.mutates;
    });
    expect(mutating.length).toBeGreaterThan(0);
    for (const tool of mutating) {
      expect(tool.description).toContain("Example arguments:");
    }
  });

  it("composes formats, terms, and an example from the registry Zod input", () => {
    const description = composeMcpToolDescription({
      narrative: "Create a Flag in an App.",
      mutates: true,
      operationId: "flags_create_fixture",
      inputSchema: z.object({
        appId: z.string().describe("Canonical App ID (app_...) or human-readable App slug."),
        lifecycleClass: z.enum(["ops", "permission"]),
      }),
    });
    expect(description).toContain("Formats:");
    expect(description).toContain("appId:");
    expect(description).toContain('"ops"');
    expect(description).toContain("Flag — a named feature toggle");
    expect(description).toContain("Example arguments:");
    expect(JSON.parse(description.split("Example arguments: ")[1] ?? "{}")).toEqual({
      appId: "app_1",
      lifecycleClass: "ops",
    });
  });
});

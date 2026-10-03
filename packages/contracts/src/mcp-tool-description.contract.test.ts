import { describe, expect, it } from "vitest";
import { z } from "zod";
import { composeMcpToolDescription } from "./mcp-tool-description";
import { assertMcpToolDescriptionContract } from "./mcp-tool-description-contract";
import { MCP_TOOL_EXAMPLE_PREFIX } from "./mcp-tool-description-example";
import { mcpToolFormatNotes } from "./mcp-tool-description-formats";
import { deriveMcpTools, type McpToolDefinition } from "./mcp-tools";
import { jsonMediaTypeSchema } from "./openapi-route";
import { unwrapField, unwrapToObject } from "./request-body-help-unwrap";
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

  it("describes undescribed id-like fields as canonical id, not selectors", () => {
    const notes = mcpToolFormatNotes(
      z.object({
        metricId: z.string(),
        appId: z.string().describe("Canonical App ID (app_...) or human-readable App slug."),
      }),
    );
    expect(notes.find((note) => note.name === "metricId")?.text).toBe("required canonical id.");
    expect(notes.find((note) => note.name === "appId")?.text).toContain("human-readable App slug");
  });

  it("advertises selectors only when the field schema describes them", () => {
    for (const tool of tools) {
      assertSelectorNotesMatchSchema(tool);
    }
  });

  it("builds the body example before merging required path parameters", () => {
    const description = composeMcpToolDescription({
      narrative: "Update a Metric.",
      mutates: true,
      operationId: "metrics_update_fixture",
      inputSchema: z.object({
        appId: z.string(),
        metricId: z.string(),
        kind: z.enum(["binomial", "count"]).optional(),
      }),
      bodySchema: z.object({
        kind: z.enum(["binomial", "count"]).optional(),
      }),
    });
    expect(JSON.parse(description.split(`${MCP_TOOL_EXAMPLE_PREFIX} `)[1] ?? "{}")).toEqual({
      appId: "app_1",
      metricId: "metric_1",
      kind: "binomial",
    });
  });

  it("every update/patch example includes at least one writable body field", () => {
    const patchTools = tools.filter(isUpdateOrPatchTool);
    expect(patchTools.length).toBeGreaterThan(0);
    for (const tool of patchTools) {
      assertUpdateExampleHasWritableField(tool);
    }
  });
});

/** Handler support: path-selector-resolution.ts rewrites app/env/flag/envs only. */
const CANONICAL_ID_ONLY_FIELDS = new Set(["metricId", "experimentId", "runId"]);

function assertSelectorNotesMatchSchema(tool: McpToolDefinition): void {
  const shape = unwrapToObject(tool.inputSchema)?.shape ?? {};
  for (const note of mcpToolFormatNotes(tool.inputSchema)) {
    assertSelectorNote(tool.name, note, shape[note.name] as z.ZodTypeAny | undefined);
  }
}

function assertSelectorNote(
  toolName: string,
  note: { readonly name: string; readonly text: string },
  fieldSchema: z.ZodTypeAny | undefined,
): void {
  const described = fieldSchema ? unwrapField(fieldSchema).inner.description : undefined;
  const label = `${toolName}.${note.name}`;
  if (CANONICAL_ID_ONLY_FIELDS.has(note.name)) {
    expect(note.text, label).not.toMatch(/human-readable|selector/i);
  }
  if (/human-readable|selector/i.test(note.text)) {
    expect(described, label).toMatch(/human-readable|selector/i);
  }
}

function isUpdateOrPatchTool(tool: McpToolDefinition): boolean {
  const route = getRoute(tool.name);
  if (!route) throw new Error(`missing route ${tool.name}`);
  return route.method === "PATCH" || tool.name.endsWith("_update");
}

function assertUpdateExampleHasWritableField(tool: McpToolDefinition): void {
  const writable = writableBodyFields(tool.name);
  if (writable.length === 0) return;
  const example = exampleArguments(tool.description);
  expect(
    writable.some((name) => example[name] !== undefined),
    `${tool.name} example ${JSON.stringify(example)} has no writable field from ${writable.join(", ")}`,
  ).toBe(true);
}

function writableBodyFields(operationId: string): string[] {
  const route = getRoute(operationId);
  if (!route) throw new Error(`missing route ${operationId}`);
  const schema = jsonMediaTypeSchema(route.openapi.request?.body?.content);
  const body = schema ? unwrapToObject(schema) : undefined;
  return body ? Object.keys(body.shape).filter((name) => name !== "idempotency_key") : [];
}

function exampleArguments(description: string): Record<string, unknown> {
  const marker = `\n\n${MCP_TOOL_EXAMPLE_PREFIX} `;
  const index = description.lastIndexOf(marker);
  if (index === -1) throw new Error("missing Example arguments");
  const parsed: unknown = JSON.parse(description.slice(index + marker.length).trim());
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Example arguments is not an object");
  }
  return parsed as Record<string, unknown>;
}

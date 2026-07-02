import { describe, expect, it } from "vitest";
import { ErrorResponseSchema } from "./errors.js";
import { deriveMcpTools, isMcpToolRoute } from "./mcp-tools.js";
import { getRoute, routeRegistry } from "./route-registry.js";

/**
 * MCP tools are derived from the registry and proven HERE — never committed. The
 * critical assertions are surface isolation (no data-plane tool, no auth/scope in
 * the tool schema) and 1:1 parity (one tool per control-plane route, with the
 * route's operationId/input/output).
 */

const tools = deriveMcpTools();
const toolNames = new Set(tools.map((tool) => tool.name));

// Routes that MUST NOT become MCP tools: the data-plane SDK endpoints and the
// public OpenAPI discovery doc. Listed explicitly so a future data-plane route
// leaking into the tool set fails loudly here.
const NON_TOOL_OPERATION_IDS = [
  "sdk_evaluate",
  "sdk_peek",
  "sdk_verify",
  "openapi_document_get",
] as const;

describe("mcp tools: surface isolation (CRITICAL)", () => {
  it("derives NO tool for the data-plane evaluate/peek/verify endpoints", () => {
    expect(toolNames.has("sdk_evaluate")).toBe(false);
    expect(toolNames.has("sdk_peek")).toBe(false);
    expect(toolNames.has("sdk_verify")).toBe(false);
  });

  it("derives NO tool for the public OpenAPI discovery doc", () => {
    expect(toolNames.has("openapi_document_get")).toBe(false);
  });

  it("every excluded route is genuinely in the registry but not a tool", () => {
    for (const id of NON_TOOL_OPERATION_IDS) {
      const route = getRoute(id);
      expect(route).toBeDefined();
      if (route === undefined) {
        throw new Error(`missing route ${id}`);
      }
      expect(isMcpToolRoute(route)).toBe(false);
      expect(toolNames.has(id)).toBe(false);
    }
  });

  it("every derived tool comes from a control-plane (token-authed) route", () => {
    for (const tool of tools) {
      const route = getRoute(tool.name);
      expect(route?.auth).toBe("control-plane-token");
    }
  });

  it("no tool definition carries the route's auth/scope guard metadata", () => {
    // A tool exposes only call shape: name/description/input/output/error. The
    // route's `auth` kind and `scopes` allow-list are guard metadata the Worker
    // enforces (surfaced via UNAUTHORIZED / INSUFFICIENT_SCOPES), never copied onto
    // the tool. (A domain field that happens to be named `scopes` in a request body
    // — e.g. the scopes a new API Key grants — is legitimate tool input, distinct
    // from the route's own guard scopes; this asserts the guard metadata, not body
    // field names.)
    for (const tool of tools) {
      const keys = Object.keys(tool);
      expect(keys).toEqual(["name", "description", "inputSchema", "outputSchema", "errorSchema"]);
      const route = getRoute(tool.name);
      expect(route).toBeDefined();
      if (route === undefined) {
        throw new Error(`missing route ${tool.name}`);
      }
      const asRecord = tool as unknown as Record<string, unknown>;
      expect(asRecord.auth).toBeUndefined();
      expect(asRecord.scopes).toBeUndefined();
      // The route itself does carry guard metadata; prove the tool dropped it.
      expect(route.auth).toBe("control-plane-token");
    }
  });
});

describe("mcp tools: 1:1 parity with control-plane routes", () => {
  it("derives exactly one tool per control-plane route", () => {
    const controlPlaneIds = routeRegistry.filter(isMcpToolRoute).map((route) => route.operationId);
    expect([...toolNames].sort()).toEqual([...controlPlaneIds].sort());
    expect(tools.length).toBe(controlPlaneIds.length);
  });

  it("covers a non-trivial number of tools (N > 0) and excludes the 4 non-tools", () => {
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.length).toBe(routeRegistry.length - NON_TOOL_OPERATION_IDS.length);
  });

  it("tool name equals the route operationId", () => {
    for (const tool of tools) {
      expect(getRoute(tool.name)).toBeDefined();
    }
  });

  it("write tool input = the route request body; read tool input = path+query", () => {
    const create = tools.find((tool) => tool.name === "flags_create");
    const route = getRoute("flags_create");
    const body = route?.openapi.request?.body?.content?.["application/json"]?.schema;
    expect(create?.inputSchema).toBe(body);

    const list = tools.find((tool) => tool.name === "flags_list");
    const listShape = (list?.inputSchema as { shape?: Record<string, unknown> }).shape ?? {};
    expect(Object.keys(listShape)).toContain("appId");
  });

  it("tool output = the route 200 response schema", () => {
    const get = tools.find((tool) => tool.name === "flags_get");
    const ok = getRoute("flags_get")?.openapi.responses[200];
    const schema = ok && "content" in ok ? ok.content?.["application/json"]?.schema : undefined;
    expect(get?.outputSchema).toBe(schema);
  });

  it("every tool shares the one ErrorResponse schema", () => {
    for (const tool of tools) {
      expect(tool.errorSchema).toBe(ErrorResponseSchema);
    }
  });
});

import { z } from "zod";
import { ErrorResponseSchema } from "./errors";
import type { ApiRouteContract } from "./openapi-route";
import { routeRegistry } from "./route-registry";

/**
 * MCP tool-schema derivation from THE single route registry (ADR-0023/0025). One
 * MCP tool per control-plane route, derived in-memory at MCP server startup — no
 * committed tool-definitions file (a committed artifact would drift from the Zod
 * routes that actually authorize at the Worker; the registry is the only truth).
 *
 * Surface isolation (CRITICAL): MCP exposes the CONTROL PLANE, not the data plane.
 * The discriminator is the route's auth kind. Control-plane routes authenticate
 * with `control-plane-token`; the data-plane SDK endpoints (evaluate/cache telemetry via Client Key,
 * peek via API Key, verify via Client/API Key) and the public discovery doc
 * (openapi_document_get) do NOT, so they derive no tool. An agent verifies via the
 * control-plane `flags_test_eval`, never the data-plane evaluate/peek/verify
 * (mcp-tool-derivation.md "Authorization").
 *
 * A tool schema is pure call shape — input/output/error. It carries NO auth or
 * scope fields: those are guard metadata the Worker enforces and surfaces via the
 * ErrorResponse (UNAUTHORIZED / INSUFFICIENT_SCOPES), never as tool input
 * (mcp-tool-derivation.md "Authorization").
 */

/** The single auth kind that marks a route as an MCP-exposed control-plane tool. */
const MCP_AUTH_KIND = "control-plane-token";

export interface McpToolDefinition {
  /** Tool name = route.operationId (stable, path-independent). */
  name: string;
  description: string;
  /** Flat path, query, and JSON body fields in the Control Plane SDK call shape. */
  inputSchema: z.ZodTypeAny;
  /** The 200 response body schema. */
  outputSchema: z.ZodTypeAny;
  /** Shared ErrorResponse discriminated union — identical for every tool. */
  errorSchema: typeof ErrorResponseSchema;
}

export interface McpProtocolToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}

/** A route is an MCP tool iff it is a control-plane (token-authed) route. */
export function isMcpToolRoute(route: ApiRouteContract): boolean {
  return route.auth === MCP_AUTH_KIND;
}

/**
 * Pull the request pieces a tool accepts out of the route's openapi config. The
 * config wraps the body under `request.body.content[json].schema`; params/query
 * are Zod object schemas directly on `request`.
 */
function requestParts(route: ApiRouteContract): {
  body?: z.ZodTypeAny;
  params?: z.ZodTypeAny;
  query?: z.ZodTypeAny;
} {
  const request = route.openapi.request ?? {};
  const json = request.body?.content?.["application/json"];
  return {
    body: json?.schema as z.ZodTypeAny | undefined,
    params: request.params as z.ZodTypeAny | undefined,
    query: request.query as z.ZodTypeAny | undefined,
  };
}

/**
 * Derive the flat tool inputSchema the Control Plane SDK accepts:
 * path params, query params, and JSON body fields all live at the top level.
 * `bodyForRoute` strips path/query fields before forwarding the HTTP body, so the
 * advertised tool schema must include every route field in the same flat shape.
 * A route with no body, path, or query (e.g. organizations_list, keyed entirely
 * off the token) correctly derives an empty-object input — that is a real
 * no-argument tool, not a malformed contract.
 */
function deriveInputSchema(route: ApiRouteContract): z.ZodTypeAny {
  const { body, params, query } = requestParts(route);
  const shape: z.ZodRawShape = {};
  if (params instanceof z.ZodObject) {
    Object.assign(shape, params.shape);
  }
  if (query instanceof z.ZodObject) {
    Object.assign(shape, query.shape);
  }
  const bodyObject = unwrapOptionalObject(body);
  if (bodyObject) {
    Object.assign(shape, bodyObject.shape);
  } else if (body) {
    if (Object.keys(shape).length > 0) {
      throw new Error(
        `mcp-tools: route "${route.operationId}" cannot derive flat input from non-object body plus path/query fields`,
      );
    }
    return body;
  }
  return z.object(shape);
}

function unwrapOptionalObject(schema: z.ZodTypeAny | undefined): z.ZodObject | undefined {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault) {
    return unwrapOptionalObject(schema.unwrap() as z.ZodTypeAny);
  }
  return schema instanceof z.ZodObject ? schema : undefined;
}

/** The 200 response schema from the route's openapi config. */
function deriveOutputSchema(route: ApiRouteContract): z.ZodTypeAny {
  const ok = route.openapi.responses[200];
  const schema =
    ok && "content" in ok
      ? (ok.content?.["application/json"]?.schema as z.ZodTypeAny | undefined)
      : undefined;
  if (!schema) {
    throw new Error(`mcp-tools: route "${route.operationId}" has no 200 response schema`);
  }
  return schema;
}

/** Derive one MCP tool from one control-plane route. */
function deriveTool(route: ApiRouteContract): McpToolDefinition {
  return {
    name: route.operationId,
    description: route.summary,
    inputSchema: deriveInputSchema(route),
    outputSchema: deriveOutputSchema(route),
    errorSchema: ErrorResponseSchema,
  };
}

/**
 * Derive the full MCP tool set from the registry, on demand. One tool per
 * control-plane route; data-plane and discovery routes are excluded by
 * {@link isMcpToolRoute}. Returns in registry order so the tool list is stable.
 */
export function deriveMcpTools(): readonly McpToolDefinition[] {
  return routeRegistry.filter(isMcpToolRoute).map(deriveTool);
}

export function deriveMcpProtocolTools(): readonly McpProtocolToolDefinition[] {
  return deriveMcpTools().map((tool) => ({
    name: tool.name,
    title: tool.name,
    description: tool.description,
    inputSchema: z.toJSONSchema(tool.inputSchema) as Record<string, unknown>,
    outputSchema: z.toJSONSchema(tool.outputSchema) as Record<string, unknown>,
  }));
}

/**
 * MCP-only operation-id dispatch over the Control Plane API.
 *
 * Normal SDK consumers should use the typed route groups on `createControlPlaneSdk()`
 * (`flags`, `experiments`, …). This adapter exists for dynamic MCP tool execution
 * where the tool name is an `operationId` string resolved at runtime.
 */
import type { ApiRouteContract, ErrorResponse } from "@splitch/contracts";
import { getRoute } from "@splitch/contracts";
import {
  type ControlPlaneHcOptions,
  withAuthorization,
} from "./hc-client";
import {
  parseControlPlaneResponse,
  type ControlPlaneOperationOptions,
  type ControlPlaneOperationResult,
} from "./operation-result";

export interface McpOperationAdapterOptions extends ControlPlaneHcOptions {}

export interface McpOperationAdapter {
  callOperationById(
    operationId: string,
    input: unknown,
    options?: ControlPlaneOperationOptions,
  ): Promise<ControlPlaneOperationResult>;
}

export function createMcpOperationAdapter(
  options: McpOperationAdapterOptions,
): McpOperationAdapter {
  const requestFetch = options.fetch ?? fetch;

  return {
    async callOperationById(operationId, input, callOptions) {
      const route = getRoute(operationId);
      if (!route) {
        throw new Error(`control-plane-sdk: unknown operation "${operationId}"`);
      }

      const hcOptions = withAuthorization(options, callOptions);
      const response = await requestFetch(
        buildRequest(route, new URL(options.baseUrl), input, hcOptions.authorization),
      );

      return parseControlPlaneResponse(response, operationId, route.output);
    },
  };
}

function buildRequest(
  route: ApiRouteContract,
  baseUrl: URL,
  input: unknown,
  authorization: string | null | undefined,
): Request {
  const url = new URL(buildPath(route, input), baseUrl);
  appendQuery(url, route, input);
  const body = bodyForRoute(route, input);
  const headers = new Headers({ accept: "application/json" });

  if (authorization) {
    headers.set("authorization", authorization);
  }
  if (body !== undefined) {
    headers.set("content-type", "application/json");
  }

  return new Request(url, {
    method: route.method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function buildPath(route: ApiRouteContract, input: unknown): string {
  const record = inputRecord(input);
  return route.path.replace(/:([A-Za-z0-9_]+)/g, (_match, key: string) => {
    const value = record[key];
    if (typeof value !== "string") {
      throw new Error(`control-plane-sdk: ${route.operationId} missing path param "${key}"`);
    }
    return encodeURIComponent(value);
  });
}

function appendQuery(url: URL, route: ApiRouteContract, input: unknown): void {
  const record = inputRecord(input);
  for (const key of objectSchemaKeys(route.openapi.request?.query)) {
    const value = record[key];
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }
}

function bodyForRoute(route: ApiRouteContract, input: unknown): unknown {
  const bodySchema = safeParseSchema(
    route.openapi.request?.body?.content?.["application/json"]?.schema,
  );
  if (!bodySchema) {
    return undefined;
  }
  const direct = bodySchema.safeParse(input);
  if (direct.success) {
    return direct.data;
  }

  const withoutRouteFields = stripKeys(input, [
    ...pathParamNames(route.path),
    ...objectSchemaKeys(route.openapi.request?.query),
  ]);
  const stripped = bodySchema.safeParse(withoutRouteFields);
  return stripped.success ? stripped.data : input;
}

type SafeParseResult = { success: true; data: unknown } | { success: false };

interface SafeParseSchema {
  safeParse(input: unknown): SafeParseResult;
}

function safeParseSchema(schema: unknown): SafeParseSchema | undefined {
  return typeof (schema as { safeParse?: unknown } | undefined)?.safeParse === "function"
    ? (schema as SafeParseSchema)
    : undefined;
}

function inputRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

function pathParamNames(path: string): string[] {
  return [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => match[1] ?? "");
}

function objectSchemaKeys(schema: unknown): string[] {
  const shape = (schema as { shape?: unknown } | undefined)?.shape;
  return shape && typeof shape === "object" ? Object.keys(shape) : [];
}

function stripKeys(input: unknown, keys: readonly string[]): unknown {
  const record = inputRecord(input);
  const stripped: Record<string, unknown> = {};
  const excluded = new Set(keys);
  for (const [key, value] of Object.entries(record)) {
    if (!excluded.has(key)) {
      stripped[key] = value;
    }
  }
  return stripped;
}

export type { ControlPlaneOperationOptions, ControlPlaneOperationResult, ErrorResponse };

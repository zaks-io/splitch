/**
 * MCP-only operation-id dispatch over the Control Plane API.
 *
 * Normal SDK consumers should use the typed route groups on `createControlPlaneSdk()`
 * (`flags`, `experiments`, …). This adapter exists for dynamic MCP tool execution
 * where the tool name is an `operationId` string resolved at runtime.
 */
import type { ApiRouteContract, ErrorResponse, McpDelegationActor } from "@splitch/contracts";
import { createMcpDelegationHeader, getRoute, MCP_DELEGATION_HEADER } from "@splitch/contracts";
import { type ControlPlaneHcOptions, resolveControlPlaneUrl, withAuthorization } from "./hc-client";
import {
  type ControlPlaneOperationOptions,
  type ControlPlaneOperationResult,
  parseControlPlaneResponse,
} from "./operation-result";

export interface McpOperationAdapterOptions extends ControlPlaneHcOptions {
  delegationSecret?: string;
}

export interface McpOperationAdapter {
  callOperationById(
    operationId: string,
    input: unknown,
    options?: McpOperationCallOptions,
  ): Promise<ControlPlaneOperationResult>;
}

export interface McpOperationCallOptions extends ControlPlaneOperationOptions {
  delegation?: McpDelegationActor;
}

export function createMcpOperationAdapter(
  options: McpOperationAdapterOptions,
): McpOperationAdapter {
  const requestFetch = options.fetch ?? fetch;

  return {
    async callOperationById(operationId, input, callOptions: McpOperationCallOptions | undefined) {
      const route = getRoute(operationId);
      if (!route) {
        throw new Error(`control-plane-sdk: unknown operation "${operationId}"`);
      }

      const hcOptions = withAuthorization(options, callOptions);
      const request = buildRequest(
        route,
        new URL(options.baseUrl),
        input,
        callOptions?.delegation ? null : hcOptions.authorization,
      );
      if (callOptions?.delegation) {
        request.headers.set(
          MCP_DELEGATION_HEADER,
          await createMcpDelegationHeader({
            operationId,
            actor: scopedDelegationActor(route, input, callOptions.delegation),
            request,
            secret: requiredDelegationSecret(options.delegationSecret),
          }),
        );
      }
      const response = await requestFetch(request);

      return parseControlPlaneResponse(response, operationId, route.output);
    },
  };
}

function scopedDelegationActor(
  route: ApiRouteContract,
  input: unknown,
  actor: NonNullable<McpOperationCallOptions["delegation"]>,
) {
  const record = inputRecord(input);
  const targets = [
    route.path.includes(":orgId") ? scopeTarget("org", record.orgId) : null,
    route.path.includes(":appId") ? scopeTarget("app", record.appId) : null,
  ].filter((target): target is string => target !== null);
  return {
    subject: actor.subject,
    // Narrowed to the route's target, but the door is NOT narrowable: it says
    // who the caller is, not what they may reach.
    authDoor: actor.authDoor,
    scopes:
      targets.length === 0
        ? actor.scopes
        : actor.scopes.filter((scope) =>
            targets.some((target) => scopeMatchesTarget(scope, target)),
          ),
  };
}

function scopeTarget(kind: "org" | "app", id: unknown): string | null {
  return typeof id === "string" ? `${kind}:${id}:` : null;
}

function scopeMatchesTarget(scope: string, target: string): boolean {
  const role = scope.slice(target.length);
  return scope.startsWith(target) && (role === "owner" || role === "admin" || role === "member");
}

function requiredDelegationSecret(secret: string | undefined): string {
  if (!secret) throw new Error("control-plane-sdk: MCP delegation secret is required");
  return secret;
}

function buildRequest(
  route: ApiRouteContract,
  baseUrl: URL,
  input: unknown,
  authorization: string | null | undefined,
): Request {
  const url = resolveControlPlaneUrl(baseUrl, buildPath(route, input));
  appendQuery(url, route, input);
  const body = bodyForRoute(route, input);
  const headers = new Headers({ accept: "application/json" });

  if (authorization) {
    headers.set("authorization", authorization);
  }
  if (body !== undefined) {
    headers.set("content-type", "application/json");
  }
  const idempotencyKey = inputRecord(input).idempotency_key;
  if (route.idempotency !== "none" && typeof idempotencyKey === "string") {
    headers.set("idempotency-key", idempotencyKey);
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
  if (stripped.success) {
    return stripped.data;
  }

  return input;
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

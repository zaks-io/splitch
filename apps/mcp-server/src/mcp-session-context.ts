import {
  type ErrorResponse,
  type McpToolAnnotations,
  mcpReversibilityMeta,
  mcpToolAnnotations,
  updateClosed,
} from "@splitch/contracts";
import { contextUseInvalidError, scopeUnresolvedError } from "./mcp-local-errors";

export interface McpSkinToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: McpToolAnnotations;
  _meta: { reversibilityClass: "reversible" | "compensable" | "irreversible" };
}

export interface McpSessionContext {
  readonly appId: string;
  readonly environmentId: string;
}

export interface McpSessionTransport {
  readonly authDoor?: string;
  readonly demoExpiresAt?: string;
}

export interface McpSessionStore {
  create(subject: string, transport?: McpSessionTransport): Promise<string>;
  get(id: string, subject: string): Promise<McpSessionContext | undefined>;
  getTransport(id: string, subject: string): Promise<McpSessionTransport | undefined>;
  set(id: string, context: McpSessionContext, subject: string): Promise<void>;
  end(id: string, subject: string): Promise<void>;
}

type McpSessionContextValidation =
  | { ok: true }
  | { ok: false; message: string; field?: "appId" | "environmentId" };

export type McpSessionContextValidator = (
  context: McpSessionContext,
) => Promise<McpSessionContextValidation>;

export const contextUseTool: McpSkinToolDefinition = {
  name: "context_use",
  description: [
    "Set the active App and Environment for this MCP transport session.",
    "Formats: appId: required Canonical App ID (app_...) or human-readable App slug. environmentId: required Canonical Environment ID (env_...) or human-readable Environment key.",
    "Terms: App — the product or service surface that groups related Flags and hosts Experiments. Environment — a named deployment context under an App, such as `dev` or `prod`.",
    'Example arguments: {"appId":"app_1","environmentId":"env_1"}',
  ].join("\n\n"),
  inputSchema: {
    type: "object",
    properties: {
      appId: { type: "string" },
      environmentId: { type: "string" },
    },
    required: ["appId", "environmentId"],
    additionalProperties: false,
  },
  annotations: mcpToolAnnotations(updateClosed),
  _meta: mcpReversibilityMeta(updateClosed),
};

function parseContext(value: unknown): McpSessionContext | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { appId, environmentId } = value as { appId?: unknown; environmentId?: unknown };
  return typeof appId === "string" &&
    appId.length > 0 &&
    typeof environmentId === "string" &&
    environmentId.length > 0
    ? { appId, environmentId }
    : null;
}

export async function setSessionContext(
  arguments_: unknown,
  sessionId: string | null,
  sessionStore: McpSessionStore,
  validate: McpSessionContextValidator,
  subject: string,
): Promise<{ ok: true; value: McpSessionContext } | { ok: false; error: ErrorResponse }> {
  if (!sessionId) {
    return {
      ok: false,
      error: contextUseInvalidError("MCP session is required before calling context_use.", [
        { path: ["session"], message: "required" },
      ]),
    };
  }
  const context = parseContext(arguments_);
  if (!context) {
    return {
      ok: false,
      error: contextUseInvalidError("context_use requires non-empty appId and environmentId.", [
        { path: ["appId"], message: "required" },
        { path: ["environmentId"], message: "required" },
      ]),
    };
  }
  // Only a resolution refusal is the caller's to fix. A validator or session
  // store that throws is an outage, and dressing it as `{ ok: false }` tells the
  // agent its own ids were wrong, so it retries new ids forever. Let it reach the
  // internal-error path instead.
  const validation = await validate(context);
  if (!validation.ok) {
    // Prefer the field the validator named. Unknown refusals stay form-level
    // (`path: []`) so an agent does not rewrite the wrong axis.
    const path = validation.field === undefined ? [] : [validation.field];
    return {
      ok: false,
      error: contextUseInvalidError(validation.message, [{ path, message: validation.message }]),
    };
  }
  await sessionStore.set(sessionId, context, subject);
  return { ok: true, value: context };
}

export async function resolveScope(
  path: string,
  arguments_: unknown,
  sessionId: string | null,
  sessionStore: McpSessionStore,
  subject: string,
): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; error: ErrorResponse }> {
  const input = inputRecord(arguments_);
  // A session store that throws is an outage, not an unresolved scope: it
  // propagates to the internal-error path rather than posing as a caller fix.
  const context = sessionId ? await sessionStore.get(sessionId, subject) : undefined;
  return resolveRouteScope(path, input, context);
}

function resolveRouteScope(
  path: string,
  input: Record<string, unknown>,
  context: McpSessionContext | undefined,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: ErrorResponse } {
  const app = resolveScopeAxis(
    input.appId,
    context?.appId,
    path.includes(":appId"),
    "App",
    "appId",
  );
  if (!app.ok) return app;

  const environmentParameter = environmentScopeParameter(path);
  const environment = resolveScopeAxis(
    environmentParameter ? input[environmentParameter] : undefined,
    context?.environmentId,
    environmentParameter !== undefined,
    "Environment",
    environmentParameter ?? "environmentId",
  );
  if (!environment.ok) return environment;

  return {
    ok: true,
    value: {
      ...input,
      ...(path.includes(":appId") && input.appId === undefined ? { appId: app.value } : {}),
      ...(environmentParameter && input[environmentParameter] === undefined
        ? { [environmentParameter]: environment.value }
        : {}),
    },
  };
}

function environmentScopeParameter(
  path: string,
): "environmentId" | "targetEnvironmentId" | undefined {
  if (path.includes(":environmentId")) return "environmentId";
  if (path.includes(":targetEnvironmentId")) return "targetEnvironmentId";
  return undefined;
}

function resolveScopeAxis(
  explicit: unknown,
  session: string | undefined,
  required: boolean,
  name: "App" | "Environment",
  parameter: string,
): { ok: true; value: string | undefined } | { ok: false; error: ErrorResponse } {
  const value = explicit ?? session;
  if (!required || (typeof value === "string" && value.length > 0)) {
    return { ok: true, value: value as string | undefined };
  }
  return {
    ok: false,
    error: scopeUnresolvedError(name, parameter),
  };
}

function inputRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function parseToolCall(params: unknown): { name: string; arguments: unknown } | null {
  if (!params || typeof params !== "object" || Array.isArray(params)) return null;
  const call = params as { name?: unknown; arguments?: unknown };
  // Default only when `arguments` is omitted. Explicit `null` (and other
  // non-objects) must survive so the tool-call path can refuse them.
  return typeof call.name === "string"
    ? {
        name: call.name,
        arguments: call.arguments === undefined ? {} : call.arguments,
      }
    : null;
}

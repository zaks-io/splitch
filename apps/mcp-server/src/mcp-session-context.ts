export interface McpSessionContext {
  readonly appId: string;
  readonly environmentId: string;
}

export interface McpSessionTransport {
  readonly authDoor?: string;
  readonly demoExpiresAt?: string;
}

export interface McpSessionStore {
  create(transport?: McpSessionTransport): Promise<string>;
  get(id: string): Promise<McpSessionContext | undefined>;
  getTransport(id: string): Promise<McpSessionTransport | undefined>;
  set(id: string, context: McpSessionContext): Promise<void>;
  end(id: string): Promise<void>;
}

type McpSessionContextValidation = { ok: true } | { ok: false; message: string };

export type McpSessionContextValidator = (
  context: McpSessionContext,
) => Promise<McpSessionContextValidation>;

export const contextUseTool = {
  name: "context_use",
  description: "Set the active App and Environment for this MCP transport session.",
  inputSchema: {
    type: "object",
    properties: {
      appId: { type: "string" },
      environmentId: { type: "string" },
    },
    required: ["appId", "environmentId"],
    additionalProperties: false,
  },
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
): Promise<{ ok: true; value: McpSessionContext } | { ok: false; message: string }> {
  if (!sessionId) {
    return { ok: false, message: "MCP session is required before calling context_use." };
  }
  const context = parseContext(arguments_);
  if (!context) {
    return { ok: false, message: "context_use requires non-empty appId and environmentId." };
  }
  try {
    const validation = await validate(context);
    if (!validation.ok) return validation;
    await sessionStore.set(sessionId, context);
    return { ok: true, value: context };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export async function resolveScope(
  path: string,
  arguments_: unknown,
  sessionId: string | null,
  sessionStore: McpSessionStore,
): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; message: string }> {
  const input = inputRecord(arguments_);
  const session = await readSessionContext(sessionId, sessionStore);
  if (!session.ok) return session;
  return resolveRouteScope(path, input, session.value);
}

function resolveRouteScope(
  path: string,
  input: Record<string, unknown>,
  context: McpSessionContext | undefined,
): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
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

async function readSessionContext(
  sessionId: string | null,
  sessionStore: McpSessionStore,
): Promise<{ ok: true; value: McpSessionContext | undefined } | { ok: false; message: string }> {
  try {
    return { ok: true, value: sessionId ? await sessionStore.get(sessionId) : undefined };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
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
): { ok: true; value: string | undefined } | { ok: false; message: string } {
  const value = explicit ?? session;
  if (!required || (typeof value === "string" && value.length > 0)) {
    return { ok: true, value: value as string | undefined };
  }
  return {
    ok: false,
    message: `${name} scope is unresolved. Call context_use or pass ${parameter} explicitly.`,
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
  return typeof call.name === "string"
    ? { name: call.name, arguments: call.arguments ?? {} }
    : null;
}

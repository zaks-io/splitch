export interface McpSessionContext {
  readonly appId: string;
  readonly environmentId: string;
}

export interface McpSessionStore {
  create(): string;
  get(id: string): McpSessionContext | undefined;
  set(id: string, context: McpSessionContext): void;
}

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

export function createMcpSessionStore(): McpSessionStore {
  const sessions = new Map<string, McpSessionContext | undefined>();
  return {
    create() {
      const id = crypto.randomUUID();
      sessions.set(id, undefined);
      return id;
    },
    get(id) {
      return sessions.get(id);
    },
    set(id, context) {
      if (!sessions.has(id)) {
        throw new Error(`mcp-server: unknown MCP session "${id}"`);
      }
      sessions.set(id, context);
    },
  };
}

function parseContext(value: unknown): McpSessionContext | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const { appId, environmentId } = value as { appId?: unknown; environmentId?: unknown };
  return typeof appId === "string" &&
    appId.length > 0 &&
    typeof environmentId === "string" &&
    environmentId.length > 0
    ? { appId, environmentId }
    : null;
}

export function setSessionContext(
  arguments_: unknown,
  sessionId: string | null,
  sessionStore: McpSessionStore,
): { ok: true; value: McpSessionContext } | { ok: false; message: string } {
  if (!sessionId) {
    return { ok: false, message: "MCP session is required before calling context_use." };
  }
  const context = parseContext(arguments_);
  if (!context) {
    return { ok: false, message: "context_use requires non-empty appId and environmentId." };
  }
  try {
    sessionStore.set(sessionId, context);
    return { ok: true, value: context };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export function resolveScope(
  path: string,
  arguments_: unknown,
  sessionId: string | null,
  sessionStore: McpSessionStore,
): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  const input = inputRecord(arguments_);
  const context = sessionId ? sessionStore.get(sessionId) : undefined;
  const app = resolveScopeAxis(
    input.appId,
    context?.appId,
    path.includes(":appId"),
    "App",
    "appId",
  );
  if (!app.ok) return app;
  const environment = resolveScopeAxis(
    input.environmentId,
    context?.environmentId,
    path.includes(":environmentId"),
    "Environment",
    "environmentId",
  );
  if (!environment.ok) return environment;
  return {
    ok: true,
    value: {
      ...input,
      ...(path.includes(":appId") && input.appId === undefined ? { appId: app.value } : {}),
      ...(path.includes(":environmentId") && input.environmentId === undefined
        ? { environmentId: environment.value }
        : {}),
    },
  };
}

function resolveScopeAxis(
  explicit: unknown,
  session: string | undefined,
  required: boolean,
  name: "App" | "Environment",
  parameter: "appId" | "environmentId",
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
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return null;
  }
  const call = params as { name?: unknown; arguments?: unknown };
  return typeof call.name === "string"
    ? { name: call.name, arguments: call.arguments ?? {} }
    : null;
}

import type { McpSessionContext, McpSessionStore } from "./mcp-session-context";

const MCP_SESSION_TTL_MS = 24 * 60 * 60 * 1_000;

interface McpSessionDurableObjectStub {
  initialize(expiresAt: number): Promise<McpSessionResult<void>>;
  getContext(now: number): Promise<McpSessionResult<McpSessionContext | undefined>>;
  setContext(context: McpSessionContext, now: number): Promise<McpSessionResult<void>>;
  end(): Promise<void>;
}

export type McpSessionResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

export interface McpSessionDurableObjectNamespace {
  getByName(name: string): McpSessionDurableObjectStub;
}

export function durableMcpSessionStore(
  namespace: McpSessionDurableObjectNamespace,
  options: { now?: () => number; ttlMs?: number } = {},
): McpSessionStore {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? MCP_SESSION_TTL_MS;
  return {
    async create() {
      const id = crypto.randomUUID();
      unwrap(await namespace.getByName(id).initialize(now() + ttlMs));
      return id;
    },
    async get(id) {
      return unwrap(await namespace.getByName(id).getContext(now()));
    },
    async set(id, context) {
      unwrap(await namespace.getByName(id).setContext(context, now()));
    },
    end(id) {
      return namespace.getByName(id).end();
    },
  };
}

function unwrap<T>(result: McpSessionResult<T>): T {
  if (!result.ok) throw new Error(result.message);
  return result.value;
}

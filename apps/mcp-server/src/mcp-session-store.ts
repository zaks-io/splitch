import type {
  McpSessionContext,
  McpSessionStore,
  McpSessionTransport,
} from "./mcp-session-context";

const MCP_SESSION_TTL_MS = 24 * 60 * 60 * 1_000;

export const MCP_SESSION_UNKNOWN_MESSAGE = "mcp-server: MCP session is unknown or expired";

interface McpSessionDurableObjectStub {
  initialize(
    expiresAt: number,
    subject: string,
    transport?: McpSessionTransport,
  ): Promise<McpSessionResult<void>>;
  getContext(
    now: number,
    subject: string,
  ): Promise<McpSessionResult<McpSessionContext | undefined>>;
  getTransport(
    now: number,
    subject: string,
  ): Promise<McpSessionResult<McpSessionTransport | undefined>>;
  setContext(
    context: McpSessionContext,
    now: number,
    subject: string,
  ): Promise<McpSessionResult<void>>;
  endForSubject(now: number, subject: string): Promise<McpSessionResult<void>>;
}

export class McpSessionNotFoundError extends Error {
  constructor() {
    super(MCP_SESSION_UNKNOWN_MESSAGE);
  }
}

export function isSessionSubject(subject: string): boolean {
  return subject.length > 0;
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
    async create(subject, transport) {
      const id = crypto.randomUUID();
      unwrap(await namespace.getByName(id).initialize(now() + ttlMs, subject, transport));
      return id;
    },
    async get(id, subject) {
      const result = await namespace.getByName(id).getContext(now(), subject);
      if (!result.ok) throw new McpSessionNotFoundError();
      return result.value;
    },
    async getTransport(id, subject) {
      const result = await namespace.getByName(id).getTransport(now(), subject);
      if (!result.ok) throw new McpSessionNotFoundError();
      return result.value;
    },
    async set(id, context, subject) {
      unwrap(await namespace.getByName(id).setContext(context, now(), subject));
    },
    async end(id, subject) {
      unwrap(await namespace.getByName(id).endForSubject(now(), subject));
    },
  };
}

function unwrap<T>(result: McpSessionResult<T>): T {
  if (!result.ok) throw new Error(result.message);
  return result.value;
}

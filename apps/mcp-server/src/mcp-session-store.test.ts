import { describe, expect, it } from "vitest";
import type { McpSessionContext, McpSessionTransport } from "./mcp-session-context";
import {
  durableMcpSessionStore,
  type McpSessionDurableObjectNamespace,
  McpSessionNotFoundError,
  type McpSessionResult,
} from "./mcp-session-store";

const owner = "user_owner";
const foreign = "user_foreign";
const context: McpSessionContext = { appId: "app_owner", environmentId: "env_owner" };
const transport: McpSessionTransport = { authDoor: "id_jag" };

describe("durable MCP session store subject binding", () => {
  it("passes the authenticated subject on create, get, set, and end", async () => {
    const { namespace, calls } = fakeNamespace();
    const store = durableMcpSessionStore(namespace, { now: () => 1_000, ttlMs: 50 });

    const id = await store.create(owner, transport);
    expect(calls).toContainEqual({
      op: "initialize",
      id,
      expiresAt: 1_050,
      subject: owner,
      transport,
    });

    await store.set(id, context, owner);
    await store.get(id, owner);
    await store.getTransport(id, owner);
    await store.end(id, owner);
    expect(calls.filter((call) => call.op !== "initialize")).toEqual([
      { op: "setContext", id, context, now: 1_000, subject: owner },
      { op: "getContext", id, now: 1_000, subject: owner },
      { op: "getTransport", id, now: 1_000, subject: owner },
      { op: "endForSubject", id, now: 1_000, subject: owner },
    ]);
  });

  it("throws the same not-found error for a foreign subject", async () => {
    const { namespace } = fakeNamespace({ rejectSubject: foreign });
    const store = durableMcpSessionStore(namespace, { now: () => 1_000 });
    const id = await store.create(owner, transport);

    await expect(store.get(id, foreign)).rejects.toBeInstanceOf(McpSessionNotFoundError);
    await expect(store.set(id, context, foreign)).rejects.toThrow(
      "mcp-server: MCP session is unknown or expired",
    );
    await expect(store.end(id, foreign)).rejects.toThrow(
      "mcp-server: MCP session is unknown or expired",
    );
  });
});

function fakeNamespace(options: { rejectSubject?: string } = {}): {
  namespace: McpSessionDurableObjectNamespace;
  calls: Array<Record<string, unknown>>;
} {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    namespace: {
      getByName(id) {
        return {
          async initialize(expiresAt, subject, sessionTransport) {
            calls.push({ op: "initialize", id, expiresAt, subject, transport: sessionTransport });
            return ok();
          },
          async getContext(now, subject) {
            calls.push({ op: "getContext", id, now, subject });
            return rejectIfForeign(subject, options.rejectSubject, undefined);
          },
          async getTransport(now, subject) {
            calls.push({ op: "getTransport", id, now, subject });
            return rejectIfForeign(subject, options.rejectSubject, undefined);
          },
          async setContext(sessionContext, now, subject) {
            calls.push({ op: "setContext", id, context: sessionContext, now, subject });
            return rejectIfForeign(subject, options.rejectSubject, undefined);
          },
          async endForSubject(now, subject) {
            calls.push({ op: "endForSubject", id, now, subject });
            return rejectIfForeign(subject, options.rejectSubject, undefined);
          },
        };
      },
    },
  };
}

function rejectIfForeign<T>(
  subject: string,
  rejectSubject: string | undefined,
  value: T,
): McpSessionResult<T> {
  if (rejectSubject && subject === rejectSubject) {
    return { ok: false, message: "mcp-server: MCP session is unknown or expired" };
  }
  return ok(value);
}

function ok<T>(value?: T): McpSessionResult<T> {
  return { ok: true, value: value as T };
}

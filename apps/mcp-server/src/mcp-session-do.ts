import { DurableObject } from "cloudflare:workers";
import type { McpSessionContext, McpSessionTransport } from "./mcp-session-context";
import type { McpSessionResult } from "./mcp-session-store";

interface SessionRecord {
  readonly expiresAt: number;
  readonly context?: McpSessionContext;
  readonly transport?: McpSessionTransport;
}

const SESSION_KEY = "session";

export class McpSessionDurableObject extends DurableObject {
  async initialize(
    expiresAt: number,
    transport?: McpSessionTransport,
  ): Promise<McpSessionResult<void>> {
    return this.ctx.blockConcurrencyWhile(async () => {
      if (await this.ctx.storage.get(SESSION_KEY)) {
        return { ok: false, message: "mcp-server: MCP session already initialized" };
      }
      await this.ctx.storage.put(SESSION_KEY, { expiresAt, transport } satisfies SessionRecord);
      await this.ctx.storage.setAlarm(expiresAt);
      return { ok: true, value: undefined };
    });
  }

  async getTransport(now: number): Promise<McpSessionResult<McpSessionTransport | undefined>> {
    const session = await this.activeRecord(now);
    return session.ok ? { ok: true, value: session.value.transport } : session;
  }

  async getContext(now: number): Promise<McpSessionResult<McpSessionContext | undefined>> {
    const session = await this.activeRecord(now);
    return session.ok ? { ok: true, value: session.value.context } : session;
  }

  async setContext(context: McpSessionContext, now: number): Promise<McpSessionResult<void>> {
    const session = await this.activeRecord(now);
    if (!session.ok) return session;
    await this.ctx.storage.put(SESSION_KEY, { ...session.value, context } satisfies SessionRecord);
    return { ok: true, value: undefined };
  }

  async end(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  override async alarm(): Promise<void> {
    await this.end();
  }

  private async activeRecord(now: number): Promise<McpSessionResult<SessionRecord>> {
    const session = await this.ctx.storage.get<SessionRecord>(SESSION_KEY);
    if (!session || session.expiresAt <= now) {
      if (session) await this.end();
      return { ok: false, message: "mcp-server: MCP session is unknown or expired" };
    }
    return { ok: true, value: session };
  }
}

import { DurableObject } from "cloudflare:workers";
import type { McpSessionContext, McpSessionTransport } from "./mcp-session-context";
import {
  isSessionSubject,
  MCP_SESSION_UNKNOWN_MESSAGE,
  type McpSessionResult,
} from "./mcp-session-store";

interface SessionRecord {
  readonly expiresAt: number;
  readonly subject: string;
  readonly context?: McpSessionContext;
  readonly transport?: McpSessionTransport;
}

const SESSION_KEY = "session";

export class McpSessionDurableObject extends DurableObject {
  async initialize(
    expiresAt: number,
    subject: string,
    transport?: McpSessionTransport,
  ): Promise<McpSessionResult<void>> {
    return this.ctx.blockConcurrencyWhile(async () => {
      if (!isSessionSubject(subject)) {
        return { ok: false, message: MCP_SESSION_UNKNOWN_MESSAGE };
      }
      if (await this.ctx.storage.get(SESSION_KEY)) {
        return { ok: false, message: "mcp-server: MCP session already initialized" };
      }
      await this.ctx.storage.put(SESSION_KEY, {
        expiresAt,
        subject,
        transport,
      } satisfies SessionRecord);
      await this.ctx.storage.setAlarm(expiresAt);
      return { ok: true, value: undefined };
    });
  }

  async getTransport(
    now: number,
    subject: string,
  ): Promise<McpSessionResult<McpSessionTransport | undefined>> {
    const session = await this.activeRecord(now, subject);
    return session.ok ? { ok: true, value: session.value.transport } : session;
  }

  async getContext(
    now: number,
    subject: string,
  ): Promise<McpSessionResult<McpSessionContext | undefined>> {
    const session = await this.activeRecord(now, subject);
    return session.ok ? { ok: true, value: session.value.context } : session;
  }

  async setContext(
    context: McpSessionContext,
    now: number,
    subject: string,
  ): Promise<McpSessionResult<void>> {
    const session = await this.activeRecord(now, subject);
    if (!session.ok) return session;
    await this.ctx.storage.put(SESSION_KEY, { ...session.value, context } satisfies SessionRecord);
    return { ok: true, value: undefined };
  }

  async endForSubject(now: number, subject: string): Promise<McpSessionResult<void>> {
    const session = await this.activeRecord(now, subject);
    if (!session.ok) return session;
    await this.clear();
    return { ok: true, value: undefined };
  }

  override async alarm(): Promise<void> {
    await this.clear();
  }

  private async activeRecord(
    now: number,
    subject: string,
  ): Promise<McpSessionResult<SessionRecord>> {
    const session = await this.ctx.storage.get<SessionRecord>(SESSION_KEY);
    if (!session || session.expiresAt <= now) {
      if (session) await this.clear();
      return { ok: false, message: MCP_SESSION_UNKNOWN_MESSAGE };
    }
    // Mismatch must not delete the owner's session, and must use the same
    // unknown/expired message so a foreign id is indistinguishable from a miss.
    if (!isSessionSubject(subject) || session.subject !== subject) {
      return { ok: false, message: MCP_SESSION_UNKNOWN_MESSAGE };
    }
    return { ok: true, value: session };
  }

  private async clear(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}

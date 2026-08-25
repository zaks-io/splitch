import type { McpDelegationReplayGuard } from "@splitch/contracts";

const CLAIM_PATH = "/claim";
const LEGACY_CLAIM_KEY = "claimed-until";
const MAX_CLAIM_TTL_SECONDS = 35;
const REPLAY_SHARD_COUNT = 16;

interface ReplayDurableObjectStub {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface McpDelegationReplayDurableObjectNamespace {
  getByName(name: string): ReplayDurableObjectStub;
}

export function mcpDelegationReplayShardName(jti: string): string {
  let hash = 0;
  for (let index = 0; index < jti.length; index++) {
    hash = (hash * 31 + jti.charCodeAt(index)) >>> 0;
  }
  return `mcp-replay-shard-${hash % REPLAY_SHARD_COUNT}`;
}

export function makeDurableMcpDelegationReplayGuard(
  namespace: McpDelegationReplayDurableObjectNamespace,
): McpDelegationReplayGuard {
  return {
    async claim(jti, expiresAt, nowSeconds, replayVersion = 2) {
      const objectName = replayVersion === 1 ? jti : mcpDelegationReplayShardName(jti);
      const response = await namespace
        .getByName(objectName)
        .fetch(`https://mcp-delegation-replay.local${CLAIM_PATH}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jti, expiresAt, nowSeconds, replayVersion }),
        });
      if (response.status === 409) return false;
      if (response.status !== 201) {
        throw new Error(`worker-runtime: MCP delegation replay claim failed (${response.status})`);
      }
      return true;
    },
  };
}

export class McpDelegationReplayDurableObject {
  constructor(private readonly ctx: DurableObjectState) {
    this.ensureSchema();
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== CLAIM_PATH) {
      return new Response("not found", { status: 404 });
    }
    const claim = await parseClaim(request);
    if (!claim) return new Response("invalid claim", { status: 400 });

    if (claim.replayVersion === 1) return this.claimLegacy(claim.expiresAt);

    this.ensureSchema();
    this.ctx.storage.sql.exec("DELETE FROM claims WHERE expires_at <= ?", claim.nowSeconds);
    const inserted = this.ctx.storage.sql
      .exec<{ jti: string }>(
        "INSERT OR IGNORE INTO claims (jti, expires_at) VALUES (?, ?) RETURNING jti",
        claim.jti,
        claim.expiresAt,
      )
      .toArray();
    if (inserted.length === 0) return new Response("replayed", { status: 409 });

    const alarm = await this.ctx.storage.getAlarm();
    const expiresAtMs = claim.expiresAt * 1_000;
    if (alarm === null || alarm > expiresAtMs) await this.ctx.storage.setAlarm(expiresAtMs);
    return new Response(null, { status: 201 });
  }

  async alarm(): Promise<void> {
    this.ensureSchema();
    this.ctx.storage.sql.exec(
      "DELETE FROM claims WHERE expires_at <= ?",
      Math.floor(Date.now() / 1_000),
    );
    const remaining = this.ctx.storage.sql
      .exec<{ next: number | null }>("SELECT min(expires_at) AS next FROM claims")
      .one();
    if (remaining.next === null) {
      await this.ctx.storage.deleteAll();
      return;
    }
    await this.ctx.storage.setAlarm(remaining.next * 1_000);
  }

  private ensureSchema(): void {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS claims (jti TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)",
    );
  }

  private claimLegacy(expiresAt: number): Promise<Response> {
    return this.ctx.storage.transaction(async (transaction) => {
      if ((await transaction.get(LEGACY_CLAIM_KEY)) !== undefined) {
        return new Response("replayed", { status: 409 });
      }
      await transaction.put(LEGACY_CLAIM_KEY, expiresAt);
      await transaction.setAlarm(expiresAt * 1_000);
      return new Response(null, { status: 201 });
    });
  }
}

async function parseClaim(
  request: Request,
): Promise<{ jti: string; expiresAt: number; nowSeconds: number; replayVersion: 1 | 2 } | null> {
  try {
    const value = (await request.json()) as Record<string, unknown>;
    const { jti, expiresAt, nowSeconds, replayVersion } = value;
    if (
      typeof jti !== "string" ||
      jti.length === 0 ||
      (replayVersion !== 1 && replayVersion !== 2) ||
      typeof expiresAt !== "number" ||
      !Number.isInteger(expiresAt) ||
      typeof nowSeconds !== "number" ||
      !Number.isInteger(nowSeconds) ||
      expiresAt <= nowSeconds ||
      expiresAt > nowSeconds + MAX_CLAIM_TTL_SECONDS
    ) {
      return null;
    }
    return { jti, expiresAt, nowSeconds, replayVersion };
  } catch {
    return null;
  }
}

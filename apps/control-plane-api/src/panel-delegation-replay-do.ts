import { DurableObject } from "cloudflare:workers";
import type { ControlPlaneApiEnv } from "./env";

/**
 * One shard of the delegation replay ledger (`replayShardName` picks the shard).
 * A nonce's redemption is linearizable because its shard processes requests on a
 * single thread and the insert is atomic on the nonce primary key.
 */
export class PanelDelegationReplayDurableObject extends DurableObject<ControlPlaneApiEnv> {
  constructor(ctx: DurableObjectState, env: ControlPlaneApiEnv) {
    super(ctx, env);
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS redemptions (nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)",
    );
  }

  async consume(nonce: string, expiresAt: number, nowSeconds: number): Promise<boolean> {
    if (expiresAt <= nowSeconds) return false;
    this.ensureSchema();
    this.ctx.storage.sql.exec("DELETE FROM redemptions WHERE expires_at <= ?", nowSeconds);
    const inserted = this.ctx.storage.sql
      .exec<{ nonce: string }>(
        "INSERT OR IGNORE INTO redemptions (nonce, expires_at) VALUES (?, ?) RETURNING nonce",
        nonce,
        expiresAt,
      )
      .toArray();
    if (inserted.length === 0) return false;
    await this.ctx.storage.setAlarm(expiresAt * 1_000);
    return true;
  }

  override async alarm(): Promise<void> {
    // Pre-shard instances were named by nonce and held a singleton `redemption`
    // row; their pending alarms still fire here, so drop that table too.
    this.ctx.storage.sql.exec("DROP TABLE IF EXISTS redemption");
    this.ensureSchema();
    this.ctx.storage.sql.exec(
      "DELETE FROM redemptions WHERE expires_at <= ?",
      Math.floor(Date.now() / 1_000),
    );
    const remaining = this.ctx.storage.sql
      .exec<{ next: number | null }>("SELECT min(expires_at) AS next FROM redemptions")
      .one();
    if (remaining.next === null) {
      await this.ctx.storage.deleteAll();
      return;
    }
    await this.ctx.storage.setAlarm(remaining.next * 1_000);
  }
}

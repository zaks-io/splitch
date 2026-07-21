import { DurableObject } from "cloudflare:workers";
import type { ControlPlaneApiEnv } from "./env";

/** A nonce-keyed object makes delegation redemption linearizable under concurrent requests. */
export class PanelDelegationReplayDurableObject extends DurableObject<ControlPlaneApiEnv> {
  constructor(ctx: DurableObjectState, env: ControlPlaneApiEnv) {
    super(ctx, env);
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS redemption (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), expires_at INTEGER NOT NULL)",
    );
  }

  async consume(expiresAt: number, nowSeconds: number): Promise<boolean> {
    if (expiresAt <= nowSeconds) return false;
    this.ensureSchema();
    const inserted = this.ctx.storage.sql
      .exec<{ singleton: number }>(
        "INSERT OR IGNORE INTO redemption (singleton, expires_at) VALUES (1, ?) RETURNING singleton",
        expiresAt,
      )
      .toArray();
    if (inserted.length === 0) return false;
    await this.ctx.storage.setAlarm(expiresAt * 1_000);
    return true;
  }

  override async alarm(): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM redemption");
  }
}

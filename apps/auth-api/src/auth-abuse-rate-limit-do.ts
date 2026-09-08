import type { RateLimitConfig } from "./rate-limit";

const HOUR_MS = 60 * 60 * 1000;
const GLOBAL_KEY = "global";
const SCHEMA = `CREATE TABLE IF NOT EXISTS windows (
  key TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  count INTEGER NOT NULL
)`;

interface AdmissionRequest {
  readonly ipDigest: string;
  readonly nowMs: number;
  readonly config: RateLimitConfig;
}

type WindowRow = Record<"started_at" | "count", number>;

type AdmissionDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: "global" | "per_ip" };

/** SQLite authority for one abuse scope's global and per-IP fixed windows. */
export class AuthAbuseRateLimitDurableObject {
  constructor(
    private readonly ctx: DurableObjectState,
    _env: unknown,
  ) {
    this.ctx.storage.sql.exec(SCHEMA);
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response("not found", { status: 404 });
    const input = parseAdmissionRequest(await request.json().catch(() => null));
    if (!input) return new Response("invalid admission request", { status: 400 });

    const decision = this.ctx.storage.transactionSync(() => this.admit(input));
    await this.scheduleCleanup();
    return Response.json(decision);
  }

  async alarm(): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM windows WHERE ? - started_at >= ?", Date.now(), HOUR_MS);
    await this.scheduleCleanup();
  }

  private admit(input: AdmissionRequest): AdmissionDecision {
    this.ctx.storage.sql.exec(
      "DELETE FROM windows WHERE ? - started_at >= ?",
      input.nowMs,
      HOUR_MS,
    );
    const ipKey = `ip:${input.ipDigest}`;
    const global = this.read(GLOBAL_KEY);
    const perIp = this.read(ipKey);
    const globalCount = (global?.count ?? 0) + 1;
    const perIpCount = (perIp?.count ?? 0) + 1;
    if (globalCount > input.config.globalPerHour) {
      return { allowed: false, reason: "global" };
    }
    if (perIpCount > input.config.perIpPerHour) {
      return { allowed: false, reason: "per_ip" };
    }
    this.write(GLOBAL_KEY, global?.started_at ?? input.nowMs, globalCount);
    this.write(ipKey, perIp?.started_at ?? input.nowMs, perIpCount);
    return { allowed: true };
  }

  private read(key: string): WindowRow | undefined {
    return this.ctx.storage.sql
      .exec<WindowRow>("SELECT started_at, count FROM windows WHERE key = ?", key)
      .toArray()[0];
  }

  private write(key: string, startedAt: number, count: number): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO windows (key, started_at, count) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET started_at = excluded.started_at, count = excluded.count`,
      key,
      startedAt,
      count,
    );
  }

  private async scheduleCleanup(): Promise<void> {
    const next = this.ctx.storage.sql
      .exec<{ next: number | null }>("SELECT min(started_at) + ? AS next FROM windows", HOUR_MS)
      .one().next;
    if (next === null) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Math.max(next, Date.now()));
  }
}

function parseAdmissionRequest(value: unknown): AdmissionRequest | null {
  if (typeof value !== "object" || value === null) return null;
  const ipDigest = "ipDigest" in value ? value.ipDigest : undefined;
  const nowMs = "nowMs" in value ? value.nowMs : undefined;
  const config = "config" in value ? value.config : undefined;
  if (
    typeof ipDigest !== "string" ||
    !/^[0-9a-f]{64}$/.test(ipDigest) ||
    typeof nowMs !== "number" ||
    !Number.isSafeInteger(nowMs) ||
    !validConfig(config)
  ) {
    return null;
  }
  return { ipDigest, nowMs, config };
}

function validConfig(value: unknown): value is RateLimitConfig {
  return (
    typeof value === "object" &&
    value !== null &&
    "perIpPerHour" in value &&
    positiveInteger(value.perIpPerHour) &&
    "globalPerHour" in value &&
    positiveInteger(value.globalPerHour)
  );
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

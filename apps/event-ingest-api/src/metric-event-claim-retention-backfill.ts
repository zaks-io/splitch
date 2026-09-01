import type { Env } from "./types";

const BATCH_SIZE = 25;
const NEXT_BATCH_DELAY_MS = 1_000;
const PIPE_NAME = "metric_event_claim_retention_backfill";
const READ_TIMEOUT_MS = 15_000;
const CHECKPOINT_KEY = "metric-event-claim-retention-backfill-v1";
const RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;

interface Checkpoint {
  readonly retainedAfter: string;
  readonly afterServerReceivedAt?: string;
  readonly afterDedupKey?: string;
  readonly done: boolean;
}

interface BackfillRow {
  readonly dedupKey: string;
  readonly serverReceivedAt: string;
}

export interface MetricEventClaimRetentionBackfillNamespace {
  getByName(name: string): {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  };
}

/** One-time, bounded adoption of claim records created before retention alarms existed. */
export class MetricEventClaimRetentionBackfillDurableObject {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/status") {
      return Response.json(await this.checkpoint());
    }
    if (request.method !== "POST" || path !== "/run") {
      return new Response("not found", { status: 404 });
    }
    await this.runBatch();
    return Response.json(await this.checkpoint());
  }

  async alarm(): Promise<void> {
    await this.runBatch();
  }

  private async runBatch(): Promise<void> {
    const checkpoint = await this.checkpoint();
    if (checkpoint.done) return;
    await this.ctx.storage.setAlarm(Date.now() + NEXT_BATCH_DELAY_MS);
    const rows = await this.readRows(checkpoint);
    for (const row of rows) await this.retain(row);
    const last = rows.at(-1);
    if (last === undefined) {
      await this.ctx.storage.put(CHECKPOINT_KEY, { ...checkpoint, done: true });
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.put(CHECKPOINT_KEY, {
      ...checkpoint,
      afterServerReceivedAt: last.serverReceivedAt,
      afterDedupKey: last.dedupKey,
    });
    await this.ctx.storage.setAlarm(Date.now() + NEXT_BATCH_DELAY_MS);
  }

  private async checkpoint(): Promise<Checkpoint> {
    const existing = await this.ctx.storage.get<Checkpoint>(CHECKPOINT_KEY);
    if (existing !== undefined) return existing;
    const initial = {
      retainedAfter: new Date(Date.now() - RETENTION_MS).toISOString(),
      done: false,
    } satisfies Checkpoint;
    await this.ctx.storage.put(CHECKPOINT_KEY, initial);
    return initial;
  }

  private async readRows(checkpoint: Checkpoint): Promise<BackfillRow[]> {
    if (!this.env.TINYBIRD_READ_TOKEN) throw new Error("TINYBIRD_READ_TOKEN is unavailable");
    if (!this.env.TINYBIRD_API_URL) throw new Error("TINYBIRD_API_URL is unavailable");
    const url = new URL(`/v0/pipes/${PIPE_NAME}.json`, this.env.TINYBIRD_API_URL);
    url.searchParams.set("retained_after", tinybirdTimestamp(checkpoint.retainedAfter));
    url.searchParams.set("limit", String(BATCH_SIZE));
    if (checkpoint.afterServerReceivedAt !== undefined) {
      url.searchParams.set(
        "after_server_received_at",
        tinybirdTimestamp(checkpoint.afterServerReceivedAt),
      );
      url.searchParams.set("after_dedup_key", checkpoint.afterDedupKey ?? "");
    }
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${this.env.TINYBIRD_READ_TOKEN}` },
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Metric Event retention backfill returned HTTP ${response.status}`);
    }
    const body = (await response.json()) as { data?: unknown };
    if (!Array.isArray(body.data)) {
      throw new Error("Metric Event retention backfill returned malformed data");
    }
    return body.data.map(parseRow);
  }

  private async retain(row: BackfillRow): Promise<void> {
    const namespace = this.env.METRIC_EVENT_OUTBOX;
    if (!namespace) throw new Error("METRIC_EVENT_OUTBOX binding is unavailable");
    const response = await namespace
      .get(namespace.idFromName(row.dedupKey))
      .fetch("https://metric-event-outbox.local/retain", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ serverReceivedAt: row.serverReceivedAt }),
      });
    if (response.status === 404 && Date.parse(row.serverReceivedAt) + RETENTION_MS <= Date.now()) {
      return;
    }
    if (!response.ok) {
      throw new Error(`Metric Event claim retention returned HTTP ${response.status}`);
    }
  }
}

function parseRow(value: unknown): BackfillRow {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Metric Event retention backfill row is invalid");
  }
  const row = value as Record<string, unknown>;
  if (
    typeof row.dedup_key !== "string" ||
    row.dedup_key.length === 0 ||
    typeof row.server_received_at !== "string"
  ) {
    throw new Error("Metric Event retention backfill row is invalid");
  }
  return {
    dedupKey: row.dedup_key,
    serverReceivedAt: new Date(parseTimestamp(row.server_received_at)).toISOString(),
  };
}

function tinybirdTimestamp(value: string): string {
  const parsed = parseTimestamp(value);
  return new Date(parsed).toISOString().replace("T", " ").replace("Z", "");
}

function parseTimestamp(value: string): number {
  const parsed = Date.parse(
    /^\d{4}-\d{2}-\d{2} /u.test(value) ? `${value.replace(" ", "T")}Z` : value,
  );
  if (!Number.isFinite(parsed)) throw new Error("Metric Event retention timestamp is invalid");
  return parsed;
}

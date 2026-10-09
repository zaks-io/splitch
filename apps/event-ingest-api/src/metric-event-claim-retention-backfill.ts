import { queueRetryDelaySeconds } from "./queue-retry";
import type { Env } from "./types";

const BATCH_SIZE = 25;
const NEXT_BATCH_DELAY_MS = 1_000;
// Seven backed-off attempts span roughly 10 to 20 minutes before the backfill halts.
const MAX_FAILED_ATTEMPTS = 7;
const PIPE_NAME = "metric_event_claim_retention_backfill";
const READ_TIMEOUT_MS = 15_000;
const CHECKPOINT_KEY = "metric-event-claim-retention-backfill-v1";
const RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;

/** Paging stopped until the daily `/run` retries from the row after the cursor. */
interface Halt {
  readonly reason: "missing-claim" | "retries-exhausted";
  readonly at: string;
  readonly serverReceivedAt?: string;
}

interface Checkpoint {
  readonly retainedAfter: string;
  readonly afterServerReceivedAt?: string;
  readonly afterDedupKey?: string;
  readonly done: boolean;
  readonly failedAttempts?: number;
  readonly halted?: Halt;
}

interface BackfillRow {
  readonly dedupKey: string;
  readonly serverReceivedAt: string;
}

type Retention = "retained" | "expired" | "missing";

export interface MetricEventClaimRetentionBackfillNamespace {
  getByName(name: string): {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  };
}

/** Runs one page now; the daily control-plane cron calls this to resume a halted backfill. */
export async function adoptMetricEventClaimRetention(env: Env): Promise<void> {
  const namespace = env.METRIC_EVENT_CLAIM_RETENTION_BACKFILL;
  if (!namespace) {
    throw new Error("METRIC_EVENT_CLAIM_RETENTION_BACKFILL binding is unavailable");
  }
  const response = await namespace.getByName("legacy-v1").fetch("https://backfill.local/run", {
    method: "POST",
  });
  if (!response.ok) {
    // The checkpoint also carries the cursor's dedup key, so name only the halt state.
    const { halted, failedAttempts } = (await response.json()) as {
      halted?: { reason: string };
      failedAttempts?: number;
    };
    throw new Error(
      `Metric Event claim retention backfill returned ${response.status}: ` +
        `halted=${halted?.reason ?? "no"} failedAttempts=${failedAttempts ?? 0}`,
    );
  }
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
    const next = await this.runBatch(await this.checkpoint());
    const healthy = next.done || (next.halted === undefined && !next.failedAttempts);
    return Response.json(next, { status: healthy ? 200 : 503 });
  }

  async alarm(): Promise<void> {
    const checkpoint = await this.checkpoint();
    // A halt waits for the daily /run, and a failed page has already scheduled its
    // backoff. Throwing here would stack the runtime's own alarm retries on top.
    if (checkpoint.halted !== undefined) return;
    await this.runBatch(checkpoint);
  }

  private async runBatch(checkpoint: Checkpoint): Promise<Checkpoint> {
    if (checkpoint.done) return checkpoint;
    const failedAttempts = (checkpoint.failedAttempts ?? 0) + 1;
    // A run evicted mid-page resumes no sooner than a failed page would retry, so a
    // page that fails the same way every time cannot spin.
    await this.ctx.storage.setAlarm(Date.now() + retryDelayMs(failedAttempts));
    let next: Checkpoint;
    try {
      next = await this.adoptPage(checkpoint);
    } catch (error) {
      next = failedPage(checkpoint, failedAttempts, error);
    }
    await this.ctx.storage.put(CHECKPOINT_KEY, next);
    if (next.done || next.halted !== undefined) {
      await this.ctx.storage.deleteAlarm();
    } else if (!next.failedAttempts) {
      await this.ctx.storage.setAlarm(Date.now() + NEXT_BATCH_DELAY_MS);
    }
    return next;
  }

  private async adoptPage(checkpoint: Checkpoint): Promise<Checkpoint> {
    const rows = await this.readRows(checkpoint);
    let adopted: BackfillRow | undefined;
    for (const row of rows) {
      if ((await this.retain(row)) === "missing") {
        // Skipping would leave a replay-protection gap unreported. Halt on the row
        // instead; it either reappears or ages out of retention before a later run.
        console.error("event-ingest-api Metric Event claim retention backfill halted", {
          reason: "missing-claim",
          serverReceivedAt: row.serverReceivedAt,
        });
        return advanced(checkpoint, adopted, {
          reason: "missing-claim",
          at: new Date().toISOString(),
          serverReceivedAt: row.serverReceivedAt,
        });
      }
      adopted = row;
    }
    return adopted === undefined
      ? { ...advanced(checkpoint, undefined), done: true }
      : advanced(checkpoint, adopted);
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

  private async retain(row: BackfillRow): Promise<Retention> {
    const namespace = this.env.METRIC_EVENT_OUTBOX;
    if (!namespace) throw new Error("METRIC_EVENT_OUTBOX binding is unavailable");
    const response = await namespace
      .get(namespace.idFromName(row.dedupKey))
      .fetch("https://metric-event-outbox.local/retain", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ serverReceivedAt: row.serverReceivedAt }),
      });
    if (response.status === 404) {
      // Shared Preview hits "missing" by construction: its Tinybird branch copies
      // production's last partition, whose claims live only in production.
      return Date.parse(row.serverReceivedAt) + RETENTION_MS <= Date.now() ? "expired" : "missing";
    }
    if (!response.ok) {
      throw new Error(`Metric Event claim retention returned HTTP ${response.status}`);
    }
    return "retained";
  }
}

/** Moves the cursor past `row` when given and clears failure state. */
function advanced(checkpoint: Checkpoint, row: BackfillRow | undefined, halted?: Halt): Checkpoint {
  return {
    retainedAfter: checkpoint.retainedAfter,
    afterServerReceivedAt: row?.serverReceivedAt ?? checkpoint.afterServerReceivedAt,
    afterDedupKey: row?.dedupKey ?? checkpoint.afterDedupKey,
    done: false,
    failedAttempts: 0,
    halted,
  };
}

function failedPage(checkpoint: Checkpoint, failedAttempts: number, error: unknown): Checkpoint {
  const exhausted = failedAttempts >= MAX_FAILED_ATTEMPTS;
  console.error("event-ingest-api Metric Event claim retention backfill failed", {
    failedAttempts,
    halted: exhausted,
    errorMessage: error instanceof Error ? error.message : "non-error rejection",
  });
  return exhausted
    ? {
        ...checkpoint,
        failedAttempts,
        halted: { reason: "retries-exhausted", at: new Date().toISOString() },
      }
    : { ...checkpoint, failedAttempts };
}

function retryDelayMs(failedAttempts: number): number {
  return queueRetryDelaySeconds(failedAttempts, CHECKPOINT_KEY) * 1_000;
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

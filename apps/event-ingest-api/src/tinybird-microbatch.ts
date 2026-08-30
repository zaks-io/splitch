import type { TinybirdDelivery } from "./types";

/**
 * The NDJSON microbatch transport for the Tinybird Events API.
 *
 * Tinybird accepts newline-delimited JSON and documents its append ceiling as
 * 100 requests per second per data source, so request count, not row count, is
 * the scarce resource. One request per row spends that budget on a single
 * consumer batch. https://www.tinybird.co/docs/forward/ingest-data/events-api
 */

/**
 * ADR-0043's uncompressed body ceiling. Tinybird rejects an oversized body with
 * 413 at 10 MB on Free and 100 MB on paid plans; 5 MiB stays inside the
 * smallest of those with room for the plan we are not on yet.
 */
export const NDJSON_MAX_BYTES = 5 * 1024 * 1024;

/** Attempts, including the first. `max_retries = 7` in wrangler.jsonc is the other seven. */
export const MAX_DELIVERY_ATTEMPTS = 8;

/** Keeps a stalled upstream below the Queue consumer's invocation lifetime. */
const TINYBIRD_REQUEST_TIMEOUT_MS = 15_000;

export type DeliveryOutcome =
  | { kind: "delivered"; successfulRows: number }
  | { kind: "retryable"; reason: string; retryAfterSeconds?: number }
  | { kind: "indeterminate"; reason: string }
  | { kind: "poison"; reason: string };

/** One bounded request body, still paired with the items whose rows it carries. */
export interface NdjsonBatch<T> {
  readonly body: string;
  readonly items: readonly T[];
}

/**
 * Split items into the fewest bounded NDJSON bodies that preserve row
 * boundaries, keeping each body paired with its items so the caller can settle
 * exactly the rows a given request carried. A single row over the ceiling is
 * its own body and fails loud at Tinybird rather than being dropped here.
 */
export function ndjsonBatches<T>(
  items: readonly T[],
  toRow: (item: T) => Record<string, unknown>,
): NdjsonBatch<T>[] {
  const batches: NdjsonBatch<T>[] = [];
  let body = "";
  // Tracked rather than measured per row: re-encoding a growing body once per
  // row makes a full batch quadratic in its own size.
  let bodyBytes = 0;
  let current: T[] = [];
  for (const item of items) {
    const line = JSON.stringify(toRow(item));
    const addition = current.length === 0 ? line : `\n${line}`;
    const additionBytes = byteLength(addition);
    if (current.length > 0 && bodyBytes + additionBytes > NDJSON_MAX_BYTES) {
      batches.push({ body, items: current });
      body = line;
      bodyBytes = byteLength(line);
      current = [item];
      continue;
    }
    body += addition;
    bodyBytes += additionBytes;
    current.push(item);
  }
  if (current.length > 0) batches.push({ body, items: current });
  return batches;
}

/** Sends one bounded NDJSON body and classifies the response per ADR-0043. */
export async function sendNdjsonBatch(
  body: string,
  rowCount: number,
  delivery: TinybirdDelivery,
): Promise<DeliveryOutcome> {
  const url = new URL(delivery.url);
  url.searchParams.set("wait", "true");
  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: "POST",
      headers: {
        authorization: `Bearer ${delivery.token}`,
        "content-type": "application/x-ndjson",
        "content-encoding": "gzip",
      },
      body: gzip(body),
      signal: AbortSignal.timeout(TINYBIRD_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    // Pre-response network failure: the request may or may not have been
    // received, so it is retryable but never blindly acknowledged.
    return { kind: "retryable", reason: `network failure: ${describe(error)}` };
  }
  return classifyResponse(response, rowCount);
}

async function classifyResponse(response: Response, rowCount: number): Promise<DeliveryOutcome> {
  if (response.status === 422) {
    // A materialized view interrupted ingestion. Neither retrying nor
    // acknowledging is safe, so it goes to reconciliation.
    return { kind: "indeterminate", reason: "Tinybird returned HTTP 422" };
  }
  if (response.status === 429 || response.status === 500 || response.status === 503) {
    if (response.status === 429) {
      console.warn("event-ingest-api Tinybird rate limited a microbatch", {
        retryAfter: response.headers.get("retry-after"),
        rateLimitLimit: response.headers.get("x-ratelimit-limit"),
        rateLimitRemaining: response.headers.get("x-ratelimit-remaining"),
        rateLimitReset: response.headers.get("x-ratelimit-reset"),
      });
    }
    return {
      kind: "retryable",
      reason: `Tinybird returned HTTP ${response.status}`,
      retryAfterSeconds: retryAfterSeconds(response),
    };
  }
  if (!response.ok) {
    return { kind: "poison", reason: `Tinybird returned HTTP ${response.status}` };
  }
  return classifyCommit(await readCommit(response), rowCount);
}

function classifyCommit(
  commit: { successfulRows: number; quarantinedRows: number } | undefined,
  rowCount: number,
): DeliveryOutcome {
  if (!commit) {
    // A 200 we cannot read is an unknown commit, not a success.
    return { kind: "indeterminate", reason: "Tinybird returned an unreadable commit body" };
  }
  if (commit.quarantinedRows > 0) {
    return {
      kind: "poison",
      reason: `Tinybird quarantined ${String(commit.quarantinedRows)} rows`,
    };
  }
  if (commit.successfulRows !== rowCount) {
    return {
      kind: "poison",
      reason: `Tinybird committed ${String(commit.successfulRows)} of ${String(rowCount)} rows`,
    };
  }
  return { kind: "delivered", successfulRows: commit.successfulRows };
}

async function readCommit(
  response: Response,
): Promise<{ successfulRows: number; quarantinedRows: number } | undefined> {
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const { successful_rows: successful, quarantined_rows: quarantined } = parsed as Record<
    string,
    unknown
  >;
  if (!Number.isInteger(successful) || !Number.isInteger(quarantined)) return undefined;
  return { successfulRows: successful as number, quarantinedRows: quarantined as number };
}

/** `Retry-After` is seconds or an HTTP date; anything else is no instruction at all. */
function retryAfterSeconds(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isInteger(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(header);
  if (!Number.isFinite(date)) return undefined;
  return Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

function gzip(body: string): ReadableStream<Uint8Array> {
  return new Blob([body]).stream().pipeThrough(new CompressionStream("gzip"));
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

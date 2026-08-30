import { afterEach, describe, expect, it, vi } from "vitest";
import { NDJSON_MAX_BYTES, ndjsonBatches, sendNdjsonBatch } from "./tinybird-microbatch";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("NDJSON batching", () => {
  it("keeps a batch that fits in a single body", () => {
    const batches = ndjsonBatches([1, 2, 3], (value) => ({ value }));

    expect(batches).toHaveLength(1);
    expect(batches[0]?.items).toEqual([1, 2, 3]);
    expect(rowsOf(batches[0]?.body)).toEqual([{ value: 1 }, { value: 2 }, { value: 3 }]);
  });

  /**
   * A body that exceeds the ceiling is rejected whole, so the split has to land
   * between rows and carry every row exactly once across the bodies it makes.
   */
  it("splits an oversized batch on row boundaries without losing a row", () => {
    const items = Array.from({ length: 8 }, (_unused, index) => index);
    const batches = ndjsonBatches(items, (index) => ({ index, blob: "x".repeat(1024 * 1024) }));

    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flatMap((batch) => [...batch.items])).toEqual(items);
    for (const batch of batches) {
      expect(byteLength(batch.body)).toBeLessThanOrEqual(NDJSON_MAX_BYTES);
      expect(rowsOf(batch.body).map((row) => row.index)).toEqual([...batch.items]);
    }
  });

  /**
   * One row wider than the ceiling cannot be split further. It gets its own
   * request and fails loud at Tinybird instead of being dropped here or
   * dragging its neighbors over the limit.
   */
  it("gives a single oversized row its own body", () => {
    const batches = ndjsonBatches(["small-before", "huge", "small-after"], (name) => ({
      name,
      blob: name === "huge" ? "x".repeat(NDJSON_MAX_BYTES + 1) : "",
    }));

    expect(batches.map((batch) => [...batch.items])).toEqual([
      ["small-before"],
      ["huge"],
      ["small-after"],
    ]);
  });

  it("makes no request for an empty batch", () => {
    expect(ndjsonBatches([], () => ({}))).toEqual([]);
  });
});

describe("Tinybird response classification", () => {
  it("bounds every upstream request with an abort signal", async () => {
    let signal: AbortSignal | null | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        signal = init?.signal;
        return Response.json({ successful_rows: 1, quarantined_rows: 0 });
      }),
    );

    await send();

    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it("reads Retry-After given as an HTTP date", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T00:00:00.000Z"));
    stubFetch(
      new Response("slow down", {
        status: 429,
        headers: { "retry-after": "Sun, 30 Aug 2026 00:00:45 GMT" },
      }),
    );

    const outcome = await send();

    expect(outcome).toEqual({
      kind: "retryable",
      reason: "Tinybird returned HTTP 429",
      retryAfterSeconds: 45,
    });
  });

  it("ignores an uninterpretable Retry-After instead of guessing a delay", async () => {
    stubFetch(new Response("slow down", { status: 503, headers: { "retry-after": "soonish" } }));

    const outcome = await send();

    expect(outcome).toEqual({
      kind: "retryable",
      reason: "Tinybird returned HTTP 503",
      retryAfterSeconds: undefined,
    });
  });

  /** A request that never got an answer may still have been committed. */
  it("treats a network failure as indeterminate rather than resubmitting", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connection reset");
      }),
    );

    expect(await send()).toEqual({
      kind: "indeterminate",
      reason: "no response: connection reset",
    });
  });
});

function send() {
  return sendNdjsonBatch('{"value":1}', 1, {
    url: "https://tinybird.test/v0/events?name=metric_events",
    token: "test-token",
  });
}

function stubFetch(response: Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response),
  );
}

function rowsOf(body: string | undefined): Record<string, unknown>[] {
  if (body === undefined) throw new Error("batch body is missing");
  return body.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

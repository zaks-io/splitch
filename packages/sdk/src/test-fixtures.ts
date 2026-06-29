import type { Logger } from "./evaluate.js";
import type { Transport, TransportRequest, TransportResult } from "./transport.js";

/**
 * Test-only fake transport: records every call (no real network) and replays a
 * scripted queue of `TransportResult`s, so a test can assert call count (the
 * "no retry" / "no second call" properties) and drive each status row of the
 * canonical mapping table. NOT shipped — used by *.test.ts only.
 *
 * `retries` is always 0 here: a single call consumes one queued result. The
 * SDK never calls `evaluate` twice for one logical resolution, so `calls.length`
 * directly proves no retry of the Exposure-bearing call occurred.
 */
export class FakeTransport implements Transport {
  readonly calls: TransportRequest[] = [];
  private readonly queue: TransportResult[];

  constructor(results: TransportResult[]) {
    this.queue = [...results];
  }

  evaluate(request: TransportRequest): Promise<TransportResult> {
    this.calls.push(request);
    const next = this.queue.shift();
    if (next === undefined) {
      throw new Error(`FakeTransport: unexpected call #${this.calls.length}, queue exhausted`);
    }
    return Promise.resolve(next);
  }
}

/** Captures loud error logs and debug logs so tests can assert fail-loud + seen-set DEBUG. */
export class FakeLogger implements Logger {
  readonly errors: { message: string; detail: unknown }[] = [];
  readonly debugs: { message: string; detail: unknown }[] = [];

  error(message: string, detail: unknown): void {
    this.errors.push({ message, detail });
  }

  debug(message: string, detail: unknown): void {
    this.debugs.push({ message, detail });
  }
}

export function ok(variant: TransportResult["variant"], runId: string): TransportResult {
  return { status: 200, variant, runId };
}

export function httpError(status: number): TransportResult {
  return { status, variant: null, runId: null };
}

export function transportFailure(): TransportResult {
  return { status: null, variant: null, runId: null };
}

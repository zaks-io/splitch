import type { Logger } from "./evaluate";
import type {
  Transport,
  TransportRequest,
  TransportResult,
  VerifyTransportResult,
} from "./transport";

/**
 * Test-only fake transport: records each accessor path (no real network) and
 * replays scripted result queues, so tests can assert call count (the "no retry"
 * / "no second call" properties) and drive each status row. NOT shipped — used
 * by *.test.ts only.
 *
 * `retries` is always 0 here: a single call consumes one queued result. The
 * SDK never calls `evaluate` twice for one logical resolution, so `calls.length`
 * directly proves no retry of the Exposure-bearing call occurred.
 */
export class FakeTransport implements Transport {
  readonly evaluateCalls: TransportRequest[] = [];
  readonly calls: TransportRequest[] = [];
  readonly peekCalls: TransportRequest[] = [];
  readonly verifyCalls: TransportRequest[] = [];
  private readonly queue: TransportResult[];
  private readonly peekQueue: TransportResult[];
  private readonly verifyQueue: VerifyTransportResult[];

  constructor(
    results: TransportResult[],
    queues: { peek?: TransportResult[]; verify?: VerifyTransportResult[] } = {},
  ) {
    this.queue = [...results];
    this.peekQueue = [...(queues.peek ?? [])];
    this.verifyQueue = [...(queues.verify ?? [])];
  }

  evaluate(request: TransportRequest): Promise<TransportResult> {
    this.evaluateCalls.push(request);
    this.calls.push(request);
    const next = this.queue.shift();
    if (next === undefined) {
      throw new Error(`FakeTransport: unexpected call #${this.calls.length}, queue exhausted`);
    }
    return Promise.resolve(next);
  }

  peek(request: TransportRequest): Promise<TransportResult> {
    this.peekCalls.push(request);
    const next = this.peekQueue.shift();
    if (next === undefined) {
      throw new Error(`FakeTransport: unexpected peek call #${this.peekCalls.length}`);
    }
    return Promise.resolve(next);
  }

  verify(request: TransportRequest): Promise<VerifyTransportResult> {
    this.verifyCalls.push(request);
    const next = this.verifyQueue.shift();
    if (next === undefined) {
      throw new Error(`FakeTransport: unexpected verify call #${this.verifyCalls.length}`);
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

export function httpError(
  status: number,
  errorCode?: TransportResult["errorCode"],
  errorMessage?: string,
): TransportResult {
  return { status, variant: null, runId: null, errorCode, errorMessage };
}

export function transportFailure(): TransportResult {
  return { status: null, variant: null, runId: null };
}

export function verifyOk(
  details: NonNullable<VerifyTransportResult["details"]>,
): VerifyTransportResult {
  return { status: 200, details };
}

export function verifyHttpError(
  status: number,
  errorCode?: VerifyTransportResult["errorCode"],
  errorMessage?: string,
): VerifyTransportResult {
  return { status, details: null, errorCode, errorMessage };
}

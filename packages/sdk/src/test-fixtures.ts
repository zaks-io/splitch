import type { Logger } from "./evaluate";
import { createFetchTransport } from "./fetch-transport";
import type {
  CachedEvaluationTelemetry,
  EvaluateAllTransportRequest,
  EvaluateAllTransportResult,
  TrackRequest,
  TrackResult,
  Transport,
  TransportRequest,
  TransportResult,
  VerifyTransportResult,
} from "./transport";

/** A minimal well-formed wire request, for tests asserting on the response side. */
export const TRANSPORT_REQUEST: TransportRequest = {
  flagKey: "flag",
  targetingKey: "u1",
  idType: "user",
  attributes: {},
  idempotencyKey: "logical-evaluation-1",
};

/** Build a stub `fetch` returning a scripted Response — no real network. */
export function stubFetch(response: Response | (() => Promise<Response>)): typeof fetch {
  return (() =>
    typeof response === "function" ? response() : Promise.resolve(response)) as typeof fetch;
}

/** The real wire adapter over a stub `fetch`, so response parsing is under test. */
export function fetchTransport(fetchImpl: typeof fetch, timeoutMs = 1000) {
  return createFetchTransport({
    credential: "pk_test",
    endpoint: "https://edge.test",
    timeoutMs,
    fetchImpl,
  });
}

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
  readonly evaluateAllCalls: EvaluateAllTransportRequest[] = [];
  recordCachedEvaluation?: (event: CachedEvaluationTelemetry) => Promise<void>;
  private readonly queue: TransportResult[];
  private readonly peekQueue: TransportResult[];
  private readonly verifyQueue: VerifyTransportResult[];
  private readonly evaluateAllQueue: EvaluateAllTransportResult[];

  constructor(
    results: TransportResult[],
    queues: {
      peek?: TransportResult[];
      verify?: VerifyTransportResult[];
      evaluateAll?: EvaluateAllTransportResult[];
    } = {},
  ) {
    this.queue = [...results];
    this.peekQueue = [...(queues.peek ?? [])];
    this.verifyQueue = [...(queues.verify ?? [])];
    this.evaluateAllQueue = [...(queues.evaluateAll ?? [])];
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

  evaluateAll(request: EvaluateAllTransportRequest): Promise<EvaluateAllTransportResult> {
    this.evaluateAllCalls.push(request);
    const next = this.evaluateAllQueue.shift();
    if (next === undefined) {
      throw new Error(
        `FakeTransport: unexpected evaluateAll call #${this.evaluateAllCalls.length}`,
      );
    }
    return Promise.resolve(next);
  }

  track(_request: TrackRequest): Promise<TrackResult> {
    throw new Error("FakeTransport: unexpected track call");
  }

  activate(_request: TrackRequest) {
    throw new Error("FakeTransport: unexpected activate call");
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

export function ok(
  variant: TransportResult["variant"],
  runId: string,
  variantName: string | null = null,
): TransportResult {
  return { status: 200, variant, variantName, runId };
}

export function httpError(
  status: number,
  errorCode?: TransportResult["errorCode"],
  errorMessage?: string,
): TransportResult {
  return { status, variant: null, variantName: null, runId: null, errorCode, errorMessage };
}

export function transportFailure(
  errorCode:
    | "SDK_TRANSPORT_NETWORK"
    | "SDK_TRANSPORT_TIMEOUT"
    | "SDK_TRANSPORT_PARSE" = "SDK_TRANSPORT_NETWORK",
  cause: unknown = new TypeError("network down"),
): TransportResult {
  return {
    status: null,
    variant: null,
    variantName: null,
    runId: null,
    errorCode,
    errorMessage: cause instanceof Error ? cause.message : "transport request failed",
    cause,
  };
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

export function evaluateAllOk(
  evaluations: NonNullable<EvaluateAllTransportResult["evaluations"]>,
  etag = '"payload-1"',
): EvaluateAllTransportResult {
  return { status: 200, evaluations, etag };
}

export function evaluateAllHttpError(
  status: number,
  errorCode?: EvaluateAllTransportResult["errorCode"],
  errorMessage?: string,
): EvaluateAllTransportResult {
  return { status, evaluations: null, etag: null, errorCode, errorMessage };
}

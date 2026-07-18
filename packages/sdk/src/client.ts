import type { EvaluateContext, EvaluateDeps, EvaluationContext, Logger } from "./evaluate";
import { runEvaluate, runPeekVariant, runVerify } from "./evaluate";
import {
  DataPlaneEvaluateResponseSchema,
  ErrorCodeSchema,
  PeekEvaluateResponseSchema,
  type ResolutionDetails,
  ResolutionDetailsSchema,
  type VariantValue,
} from "./generated/contract-surface.js";
import { SeenSet } from "./seen-set";
import type {
  Transport,
  TransportFailure,
  TransportRequest,
  TransportResult,
  VerifyTransportResult,
} from "./transport";

/**
 * Public SDK entry. A client is constructed with exactly one credential — a
 * public `clientKey` (browser/mobile) or a secret `apiKey` (server) — and lazily
 * fetches on the first evaluate (no config fetch at init, public-evaluate-endpoint.md).
 *
 * `transport` and `logger` are injectable seams: the default transport is a
 * `fetch` HTTP adapter; tests substitute a fake that records each accessor path.
 */
export interface SplitchClientOptions {
  readonly clientKey?: string;
  readonly apiKey?: string;
  /** Override for self-hosted / preview Workers. */
  readonly endpoint?: string;
  /** Per-call request timeout; on timeout the SDK fails loud (reason: ERROR). */
  readonly timeoutMs?: number;
  /** Retries on the Exposure-bearing call. MUST be 0 — a retry is a fresh resolution. */
  readonly retries?: number;
  readonly transport?: Transport;
  readonly logger?: Logger;
  readonly seenSetMaxSize?: number;
  /** Seen-set revalidation window; a Run boundary is detected within this many ms. */
  readonly revalidateMs?: number;
  /** Injectable `fetch` (defaults to global) — for the real-adapter tests, no network. */
  readonly fetch?: typeof fetch;
  /** Injectable epoch-ms clock (defaults to `Date.now`) — for TTL tests. */
  readonly now?: () => number;
}

export interface SplitchClient {
  /** Resolve a Flag and return the unwrapped Variant value. Fires an Exposure. */
  evaluate(flagKey: string, context: EvaluationContext): Promise<VariantValue>;
  /** Resolve a Flag and return the full OpenFeature ResolutionDetails. Fires an Exposure. */
  evaluateDetails(flagKey: string, context: EvaluationContext): Promise<ResolutionDetails>;
  /** Resolve a Flag without firing an Exposure. API Key only. */
  peekVariant(flagKey: string, context: EvaluateContext): Promise<VariantValue>;
  /** Verify setup without firing an Exposure. Client Key or API Key. */
  verify(flagKey: string, context: EvaluateContext): Promise<ResolutionDetails>;
}

const DEFAULT_ENDPOINT = "https://edge.splitch.dev";
const DEFAULT_TIMEOUT_MS = 1000;
const DEFAULT_RETRIES = 0;
// `X-Run-Id` carries the live Run id as non-revealing operational metadata
// alongside the bare `{ variant }` body, so the seen-set key has its runId
// without the response body leaking Run internals (ADR-0018, see transport.ts).
const RUN_ID_HEADER = "x-run-id";

export function createSplitchClient(options: SplitchClientOptions): SplitchClient {
  const credential = resolveCredential(options);
  if (options.retries !== undefined && options.retries !== DEFAULT_RETRIES) {
    // Fail loud: silently retrying an Exposure-bearing call would double-count.
    throw new Error("splitch SDK does not retry the Exposure-bearing evaluate (retries must be 0)");
  }

  const deps: EvaluateDeps = {
    transport:
      options.transport ??
      createFetchTransport({
        credential,
        endpoint: options.endpoint ?? DEFAULT_ENDPOINT,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        fetchImpl: options.fetch ?? fetch,
      }),
    seenSet: new SeenSet(options.seenSetMaxSize, options.revalidateMs),
    logger: options.logger ?? console,
    now: options.now ?? Date.now,
  };

  return {
    async evaluate(flagKey, context) {
      const details = await runEvaluate(deps, flagKey, context);
      return details.value;
    },
    evaluateDetails(flagKey, context) {
      return runEvaluate(deps, flagKey, context);
    },
    peekVariant(flagKey, context) {
      return runPeekVariant(deps, flagKey, context);
    },
    verify(flagKey, context) {
      return runVerify(deps, flagKey, context);
    },
  };
}

function resolveCredential(options: SplitchClientOptions): string {
  const hasClient = typeof options.clientKey === "string" && options.clientKey.length > 0;
  const hasApi = typeof options.apiKey === "string" && options.apiKey.length > 0;
  if (hasClient === hasApi) {
    // Exactly one credential; presenting both or neither is a setup bug.
    throw new Error("splitch SDK requires exactly one of clientKey or apiKey");
  }
  return (options.clientKey ?? options.apiKey) as string;
}

interface FetchTransportConfig {
  readonly credential: string;
  readonly endpoint: string;
  readonly timeoutMs: number;
  /** Injected so the adapter is testable with a stub fetch — no real network. */
  readonly fetchImpl: typeof fetch;
}

/**
 * The real network adapter: distinct `evaluate`, `peek`, and `verify` routes.
 * Folds every transport outcome (HTTP status, network error, timeout,
 * body-parse failure) into structured results so the SDK core never touches the wire.
 */
export function createFetchTransport(config: FetchTransportConfig): Transport {
  const urls = {
    evaluate: new URL("/api/sdk/evaluate", config.endpoint),
    peek: new URL("/api/sdk/peek", config.endpoint),
    verify: new URL("/api/sdk/verify", config.endpoint),
    telemetry: new URL("/api/sdk/evaluation-telemetry", config.endpoint),
  };

  async function post(
    path: keyof typeof urls,
    request: TransportRequest,
    signal: AbortSignal,
  ): Promise<Response> {
    return config.fetchImpl(urls[path], {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.credential}`,
        "content-type": "application/json",
        ...(request.idempotencyKey === undefined
          ? {}
          : { "idempotency-key": request.idempotencyKey }),
        "x-splitch-sdk-runtime": "javascript",
      },
      body: JSON.stringify({
        flagKey: request.flagKey,
        targetingKey: request.targetingKey,
        idType: request.idType,
        attributes: request.attributes,
      }),
      signal,
    });
  }

  async function withTimeout<Result>(
    call: (signal: AbortSignal) => Promise<Result>,
  ): Promise<Result> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      return await call(controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  // The body read stays inside the timeout scope: a server that returns headers
  // quickly but stalls the body would otherwise hang past `timeoutMs`, because
  // the abort timer is cleared as soon as `call` settles.
  return {
    async evaluate(request: TransportRequest): Promise<TransportResult> {
      try {
        return await withTimeout(async (signal) =>
          readEvaluateResponse(await post("evaluate", request, signal)),
        );
      } catch {
        // Network error or timeout (abort): a transport-level failure, status null.
        return { status: null, variant: null, runId: null };
      }
    },
    async peek(request: TransportRequest): Promise<TransportResult> {
      try {
        return await withTimeout(async (signal) =>
          readPeekResponse(await post("peek", request, signal)),
        );
      } catch {
        return { status: null, variant: null, runId: null };
      }
    },
    async verify(request: TransportRequest): Promise<VerifyTransportResult> {
      try {
        return await withTimeout(async (signal) =>
          readVerifyResponse(await post("verify", request, signal)),
        );
      } catch {
        return { status: null, details: null };
      }
    },
    async recordCachedEvaluation(event) {
      const response = await withTimeout((signal) =>
        config.fetchImpl(urls.telemetry, {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.credential}`,
            "content-type": "application/json",
            "idempotency-key": event.idempotencyKey,
            "x-splitch-sdk-runtime": "javascript",
          },
          body: JSON.stringify(event),
          signal,
        }),
      );
      if (!response.ok)
        throw new Error(`cached Evaluation telemetry failed: HTTP ${response.status}`);
    },
  };
}

async function readEvaluateResponse(response: Response): Promise<TransportResult> {
  const runId = response.headers.get(RUN_ID_HEADER);
  if (!response.ok) {
    return { ...(await readFailure(response)), variant: null, runId: null };
  }
  try {
    const body = DataPlaneEvaluateResponseSchema.parse(await response.json());
    return { status: response.status, variant: body.variant, runId };
  } catch {
    // A 200 with an unparseable body is a parse failure -> fail loud as status null.
    return { status: null, variant: null, runId: null };
  }
}

async function readPeekResponse(response: Response): Promise<TransportResult> {
  if (!response.ok) {
    return { ...(await readFailure(response)), variant: null, runId: null };
  }
  try {
    const body = PeekEvaluateResponseSchema.parse(await response.json());
    return { status: response.status, variant: body.variant, runId: null };
  } catch {
    return { status: null, variant: null, runId: null };
  }
}

async function readVerifyResponse(response: Response): Promise<VerifyTransportResult> {
  if (!response.ok) {
    return { ...(await readFailure(response)), details: null };
  }
  try {
    return {
      status: response.status,
      details: ResolutionDetailsSchema.parse(await response.json()),
    };
  } catch {
    return { status: null, details: null };
  }
}

async function readFailure(response: Response): Promise<TransportFailure> {
  const fallback: TransportFailure = { status: response.status };
  try {
    const body = (await response.json()) as { code?: unknown; message?: unknown };
    const parsedCode = ErrorCodeSchema.safeParse(body.code);
    return {
      status: response.status,
      errorCode: parsedCode.success ? parsedCode.data : undefined,
      errorMessage: typeof body.message === "string" ? body.message : undefined,
    };
  } catch {
    return fallback;
  }
}

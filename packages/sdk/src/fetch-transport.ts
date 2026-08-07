import { SplitchSdkError } from "./errors";
import {
  DataPlaneEvaluateResponseSchema,
  ErrorCodeSchema,
  EvaluateAllResponseSchema,
  PeekEvaluateResponseSchema,
  ResolutionDetailsSchema,
} from "./generated/contract-surface.js";
import type {
  EvaluateAllTransportRequest,
  EvaluateAllTransportResult,
  Transport,
  TransportFailure,
  TransportRequest,
  TransportResult,
  VerifyTransportResult,
} from "./transport";

// `X-Run-Id` carries the live Run id as non-revealing operational metadata
// alongside the `{ variant }` body, so the seen-set key has its runId without the
// response body leaking Run internals (ADR-0018, see transport.ts).
const RUN_ID_HEADER = "x-run-id";
// The resolved arm label, which the SDK cannot synthesize (two arms may share a
// value). It rides a header rather than the body because published SDKs parse
// that body strictly and would reject an added key; absent means no arm matched.
const VARIANT_NAME_HEADER = "x-variant-name";
// The strong validator over the Precomputed Evaluations body. The edge marks it
// CORS-readable (`Access-Control-Expose-Headers`) so a browser client can
// revalidate with it.
const ETAG_HEADER = "etag";

export interface FetchTransportConfig {
  readonly credential: string;
  readonly endpoint: string;
  readonly timeoutMs: number;
  /** Injected so the adapter is testable with a stub fetch — no real network. */
  readonly fetchImpl: typeof fetch;
}

function isAbortError(error: unknown): boolean {
  return (
    (typeof DOMException !== "undefined" &&
      error instanceof DOMException &&
      error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

/** Local throw / network failure that never produced an HTTP response. */
function networkFailure(cause: unknown): TransportFailure {
  return {
    status: null,
    errorCode: "SDK_TRANSPORT_NETWORK",
    errorMessage: errorMessage(cause, "transport request failed"),
    cause,
  };
}

/** Per-call timeout or AbortSignal abort. */
function timeoutFailure(cause: unknown): TransportFailure {
  return {
    status: null,
    errorCode: "SDK_TRANSPORT_TIMEOUT",
    errorMessage: errorMessage(cause, "request timed out"),
    cause,
  };
}

/** Response body that could not be parsed as the expected shape. */
function parseFailure(cause: unknown): TransportFailure {
  return {
    status: null,
    errorCode: "SDK_TRANSPORT_PARSE",
    errorMessage: errorMessage(cause, "response body was unparseable"),
    cause,
  };
}

function classifyCaughtError(error: unknown): TransportFailure {
  return isAbortError(error) ? timeoutFailure(error) : networkFailure(error);
}

/**
 * Body-read failures land here (inside the timeout scope). An AbortError is a
 * timeout that fired while the body was still streaming — not a parse error.
 */
function classifyBodyReadError(error: unknown): TransportFailure {
  return isAbortError(error) ? timeoutFailure(error) : parseFailure(error);
}

/**
 * The real network adapter: distinct `evaluate`, `peek`, and `verify` routes.
 * Folds every transport outcome (HTTP status, network error, timeout,
 * body-parse failure) into structured results so the SDK core never touches the wire.
 * Client-side failures keep their underlying `cause` and a distinct
 * `SDK_TRANSPORT_*` code — never the server's `SERVICE_UNAVAILABLE`.
 */
export function createFetchTransport(config: FetchTransportConfig): Transport {
  const urls = {
    evaluate: new URL("/api/sdk/evaluate", config.endpoint),
    peek: new URL("/api/sdk/peek", config.endpoint),
    verify: new URL("/api/sdk/verify", config.endpoint),
    evaluateAll: new URL("/api/sdk/evaluate-all", config.endpoint),
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

  // Separate from `post`: the bulk route takes no `flagKey`, and its
  // Idempotency-Key is required rather than caller-optional.
  async function postEvaluateAll(
    request: EvaluateAllTransportRequest,
    signal: AbortSignal,
  ): Promise<Response> {
    return config.fetchImpl(urls.evaluateAll, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.credential}`,
        "content-type": "application/json",
        "idempotency-key": request.idempotencyKey,
        "x-splitch-sdk-runtime": "javascript",
      },
      body: JSON.stringify({
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
      } catch (error) {
        return { ...classifyCaughtError(error), variant: null, variantName: null, runId: null };
      }
    },
    async peek(request: TransportRequest): Promise<TransportResult> {
      try {
        return await withTimeout(async (signal) =>
          readPeekResponse(await post("peek", request, signal)),
        );
      } catch (error) {
        return { ...classifyCaughtError(error), variant: null, variantName: null, runId: null };
      }
    },
    async verify(request: TransportRequest): Promise<VerifyTransportResult> {
      try {
        return await withTimeout(async (signal) =>
          readVerifyResponse(await post("verify", request, signal)),
        );
      } catch (error) {
        return { ...classifyCaughtError(error), details: null };
      }
    },
    async evaluateAll(request: EvaluateAllTransportRequest): Promise<EvaluateAllTransportResult> {
      try {
        return await withTimeout(async (signal) =>
          readEvaluateAllResponse(await postEvaluateAll(request, signal)),
        );
      } catch (error) {
        return { ...classifyCaughtError(error), evaluations: null, etag: null };
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
      if (!response.ok) {
        throw new SplitchSdkError({
          code: "SDK_CACHED_TELEMETRY_FAILED",
          causeSummary: `Cached Evaluation telemetry failed with HTTP ${response.status}`,
          remediation: "Check data-plane availability before retrying the logical Evaluation",
          status: response.status,
        });
      }
    },
  };
}

async function readEvaluateResponse(response: Response): Promise<TransportResult> {
  const runId = response.headers.get(RUN_ID_HEADER);
  if (!response.ok) {
    return { ...(await readFailure(response)), variant: null, variantName: null, runId: null };
  }
  try {
    const body = DataPlaneEvaluateResponseSchema.parse(await response.json());
    const encodedVariantName = response.headers.get(VARIANT_NAME_HEADER);
    return {
      status: response.status,
      variant: body.variant,
      // Percent-encoded by the edge because header values are ByteStrings and
      // Variant names are not. A malformed value throws out of decodeURIComponent
      // into the parse-failure path below rather than being guessed at.
      variantName: encodedVariantName === null ? null : decodeURIComponent(encodedVariantName),
      runId,
    };
  } catch (error) {
    // Abort during the body read is a timeout (timer still armed); anything else
    // is an unparseable body. Do not route either through classifyCaughtError —
    // that would label a genuine parse error as SDK_TRANSPORT_NETWORK.
    return { ...classifyBodyReadError(error), variant: null, variantName: null, runId: null };
  }
}

async function readPeekResponse(response: Response): Promise<TransportResult> {
  if (!response.ok) {
    return { ...(await readFailure(response)), variant: null, variantName: null, runId: null };
  }
  try {
    const body = PeekEvaluateResponseSchema.parse(await response.json());
    return { status: response.status, variant: body.variant, variantName: null, runId: null };
  } catch (error) {
    return { ...classifyBodyReadError(error), variant: null, variantName: null, runId: null };
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
  } catch (error) {
    return { ...classifyBodyReadError(error), details: null };
  }
}

async function readEvaluateAllResponse(response: Response): Promise<EvaluateAllTransportResult> {
  if (!response.ok) {
    return { ...(await readFailure(response)), evaluations: null, etag: null };
  }
  try {
    const body = EvaluateAllResponseSchema.parse(await response.json());
    const etag = response.headers.get(ETAG_HEADER);
    if (etag === null || etag.length === 0) {
      // The tag is what a bootstrapped client revalidates with, so a body
      // without one is an incomplete payload rather than a payload with an
      // absent optional. Fail loud instead of handing back a fabricated tag.
      throw new Error("evaluate-all response is missing its ETag header");
    }
    return { status: response.status, evaluations: body.evaluations, etag };
  } catch (error) {
    return { ...classifyBodyReadError(error), evaluations: null, etag: null };
  }
}

async function readFailure(response: Response): Promise<TransportFailure> {
  try {
    const body = (await response.json()) as { code?: unknown; message?: unknown };
    const parsedCode = ErrorCodeSchema.safeParse(body.code);
    return {
      status: response.status,
      errorCode: parsedCode.success ? parsedCode.data : undefined,
      errorMessage: typeof body.message === "string" ? body.message : undefined,
    };
  } catch (error) {
    // Same classification as the 2xx body reads: an abort here is this SDK's own
    // timer firing mid-body, so it reports the local timeout rather than the
    // server's status. Any other body-read failure arrived after a complete
    // status line, so the server's verdict stands (an empty 503 stays
    // SERVICE_UNAVAILABLE) — but the caught error rides along, so a mid-body
    // drop is distinguishable in the log from a clean empty body.
    return isAbortError(error)
      ? classifyBodyReadError(error)
      : { status: response.status, cause: error };
  }
}

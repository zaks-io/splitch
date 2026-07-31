import {
  DataPlaneEvaluateResponseSchema,
  ErrorCodeSchema,
  PeekEvaluateResponseSchema,
  ResolutionDetailsSchema,
} from "./generated/contract-surface.js";
import type {
  Transport,
  TransportFailure,
  TransportRequest,
  TransportResult,
  VerifyTransportResult,
} from "./transport";
import { SplitchSdkError } from "./errors";

// `X-Run-Id` carries the live Run id as non-revealing operational metadata
// alongside the bare `{ variant }` body, so the seen-set key has its runId
// without the response body leaking Run internals (ADR-0018, see transport.ts).
const RUN_ID_HEADER = "x-run-id";

export interface FetchTransportConfig {
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

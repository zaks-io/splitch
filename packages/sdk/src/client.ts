import type { ResolutionDetails, VariantValue } from "@splitch/contracts";
import type { EvaluateContext, EvaluateDeps, Logger } from "./evaluate.js";
import { runEvaluate } from "./evaluate.js";
import { SeenSet } from "./seen-set.js";
import type { Transport, TransportRequest, TransportResult } from "./transport.js";

/**
 * Public SDK entry. A client is constructed with exactly one credential — a
 * public `clientKey` (browser/mobile) or a secret `apiKey` (server) — and lazily
 * fetches on the first evaluate (no config fetch at init, public-evaluate-endpoint.md).
 *
 * `transport` and `logger` are injectable seams: the default transport is a
 * `fetch` HTTP adapter; tests substitute a fake that records calls and retries.
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
  evaluate(flagKey: string, context: EvaluateContext): Promise<VariantValue>;
  /** Resolve a Flag and return the full OpenFeature ResolutionDetails. Fires an Exposure. */
  evaluateDetails(flagKey: string, context: EvaluateContext): Promise<ResolutionDetails>;
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
 * The real network adapter: one `POST /api/sdk/evaluate`, no retry. Folds every
 * transport outcome (HTTP status, network error, timeout, body-parse failure)
 * into a structured `TransportResult` so the SDK core never touches the wire.
 */
export function createFetchTransport(config: FetchTransportConfig): Transport {
  const url = new URL("/api/sdk/evaluate", config.endpoint);
  return {
    async evaluate(request: TransportRequest): Promise<TransportResult> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs);
      try {
        const response = await config.fetchImpl(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.credential}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            flagKey: request.flagKey,
            targetingKey: request.targetingKey,
            idType: request.idType,
            attributes: request.attributes,
          }),
          signal: controller.signal,
        });
        return await readResponse(response);
      } catch {
        // Network error or timeout (abort): a transport-level failure, status null.
        return { status: null, variant: null, runId: null };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

async function readResponse(response: Response): Promise<TransportResult> {
  const runId = response.headers.get(RUN_ID_HEADER);
  if (!response.ok) {
    return { status: response.status, variant: null, runId: null };
  }
  try {
    const body = (await response.json()) as { variant?: VariantValue | null };
    return { status: response.status, variant: body.variant ?? null, runId };
  } catch {
    // A 200 with an unparseable body is a parse failure -> fail loud as status null.
    return { status: null, variant: null, runId: null };
  }
}

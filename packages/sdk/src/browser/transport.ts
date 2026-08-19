import type {
  EvaluateAllEntry,
  ExposureBatchItem,
  ExposureBatchResult,
} from "../generated/contract-surface.js";
import {
  EvaluateAllResponseSchema,
  ExposureBatchResponseSchema,
} from "../generated/contract-surface.js";
import type { AttributeValue } from "../transport";
import {
  type BrowserTransportFailure,
  classifyBodyReadError,
  classifyCaughtError,
  readFailure,
  withTimeout,
} from "./http";

const ETAG_HEADER = "etag";

export interface BrowserFetchTransportConfig {
  readonly credential: string;
  readonly endpoint: string;
  readonly timeoutMs: number;
  readonly fetchImpl: typeof fetch;
}

interface BrowserEvaluateAllRequest {
  readonly targetingKey: string;
  readonly idType: string;
  readonly attributes: Readonly<Record<string, AttributeValue>>;
  readonly idempotencyKey: string;
  readonly ifNoneMatch?: string;
}

export interface BrowserEvaluateAllResult extends BrowserTransportFailure {
  readonly evaluations: Readonly<Record<string, EvaluateAllEntry>> | null;
  readonly etag: string | null;
}

export interface BrowserExposuresResult extends BrowserTransportFailure {
  readonly results: readonly ExposureBatchResult[] | null;
}

/**
 * Browser-only network adapter: Precomputed Evaluations fetch + Exposure batch
 * redemption. Deliberately omits evaluate/peek/verify *methods*; shared
 * contract-surface validators may still appear in the bundle via the generated
 * module, but those routes are not callable from this adapter.
 */
export interface BrowserTransport {
  evaluateAll(request: BrowserEvaluateAllRequest): Promise<BrowserEvaluateAllResult>;
  redeemExposures(
    exposures: readonly ExposureBatchItem[],
    options?: { readonly keepalive?: boolean },
  ): Promise<BrowserExposuresResult>;
}

export function createBrowserFetchTransport(config: BrowserFetchTransportConfig): BrowserTransport {
  const evaluateAllUrl = new URL("/api/sdk/evaluate-all", config.endpoint);
  const exposuresUrl = new URL("/api/sdk/exposures", config.endpoint);
  // Hoist off the config object: a member call would set `this` to `config`,
  // which breaks a consumer-supplied `window.fetch` (Illegal invocation).
  const doFetch = config.fetchImpl;

  return {
    async evaluateAll(request) {
      try {
        return await withTimeout(config.timeoutMs, async (signal) => {
          const response = await doFetch(evaluateAllUrl, {
            method: "POST",
            headers: {
              authorization: `Bearer ${config.credential}`,
              "content-type": "application/json",
              "idempotency-key": request.idempotencyKey,
              "x-splitch-sdk-runtime": "javascript",
              ...(request.ifNoneMatch === undefined
                ? {}
                : { "if-none-match": request.ifNoneMatch }),
            },
            body: JSON.stringify({
              targetingKey: request.targetingKey,
              idType: request.idType,
              attributes: request.attributes,
            }),
            signal,
          });
          return readEvaluateAllResponse(response);
        });
      } catch (error) {
        return { ...classifyCaughtError(error), evaluations: null, etag: null };
      }
    },

    async redeemExposures(exposures, options) {
      try {
        return await withTimeout(config.timeoutMs, async (signal) => {
          const response = await doFetch(exposuresUrl, {
            method: "POST",
            headers: {
              authorization: `Bearer ${config.credential}`,
              "content-type": "application/json",
              "x-splitch-sdk-runtime": "javascript",
            },
            body: JSON.stringify({ exposures }),
            signal,
            ...(options?.keepalive === true ? { keepalive: true } : {}),
          });
          return readExposuresResponse(response);
        });
      } catch (error) {
        return { ...classifyCaughtError(error), results: null };
      }
    },
  };
}

async function readEvaluateAllResponse(response: Response): Promise<BrowserEvaluateAllResult> {
  if (response.status === 304) {
    return { status: 304, evaluations: null, etag: null };
  }
  if (!response.ok) {
    return { ...(await readFailure(response)), evaluations: null, etag: null };
  }
  try {
    const body = EvaluateAllResponseSchema.parse(await response.json());
    const etag = response.headers.get(ETAG_HEADER);
    if (etag === null || etag.length === 0) {
      throw new Error("evaluate-all response is missing its ETag header");
    }
    return { status: response.status, evaluations: body.evaluations, etag };
  } catch (error) {
    return { ...classifyBodyReadError(error), evaluations: null, etag: null };
  }
}

async function readExposuresResponse(response: Response): Promise<BrowserExposuresResult> {
  // 202 Accepted is the success status on the exposures route.
  if (!(response.ok || response.status === 202)) {
    return { ...(await readFailure(response)), results: null };
  }
  try {
    const body = ExposureBatchResponseSchema.parse(await response.json());
    return { status: response.status, results: body.results };
  } catch (error) {
    return { ...classifyBodyReadError(error), results: null };
  }
}

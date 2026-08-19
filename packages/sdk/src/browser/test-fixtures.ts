import type { EvaluateAllEntry, ExposureBatchItem } from "../generated/contract-surface.js";
import type {
  BrowserEvaluateAllResult,
  BrowserExposuresResult,
  BrowserTransport,
} from "./transport";

export const BROWSER_EVALUATIONS: Record<string, EvaluateAllEntry> = {
  "new-checkout": {
    variant: true,
    variantName: "treatment",
    reason: "SPLIT",
    errorCode: null,
    exposureTicket: "ticket-checkout",
    exposureIdentity: "identity-checkout",
  },
  "legacy-banner": {
    variant: false,
    variantName: "off",
    reason: "DEFAULT",
    errorCode: null,
    exposureTicket: null,
    exposureIdentity: null,
  },
  "broken-flag": {
    variant: null,
    variantName: null,
    reason: "ERROR",
    errorCode: "SERVICE_UNAVAILABLE",
    exposureTicket: null,
    exposureIdentity: null,
  },
};

export class FakeBrowserTransport implements BrowserTransport {
  readonly evaluateAllCalls: unknown[] = [];
  readonly redeemCalls: { exposures: readonly ExposureBatchItem[]; keepalive?: boolean }[] = [];
  private evaluateAllQueue: BrowserEvaluateAllResult[];
  private redeemQueue: BrowserExposuresResult[];

  constructor(
    evaluateAllResults: BrowserEvaluateAllResult[],
    redeemResults: BrowserExposuresResult[] = [],
  ) {
    this.evaluateAllQueue = [...evaluateAllResults];
    this.redeemQueue = [...redeemResults];
  }

  evaluateAll(request: unknown): Promise<BrowserEvaluateAllResult> {
    this.evaluateAllCalls.push(request);
    const next = this.evaluateAllQueue.shift();
    if (next === undefined) {
      throw new Error("FakeBrowserTransport: evaluateAll queue exhausted");
    }
    return Promise.resolve(next);
  }

  redeemExposures(
    exposures: readonly ExposureBatchItem[],
    options?: { readonly keepalive?: boolean },
  ): Promise<BrowserExposuresResult> {
    this.redeemCalls.push({ exposures, keepalive: options?.keepalive });
    const next = this.redeemQueue.shift();
    if (next === undefined) {
      return Promise.resolve({
        status: 202,
        results: exposures.map((item) => ({
          exposureId: item.exposureId,
          status: "accepted" as const,
          code: null,
        })),
      });
    }
    return Promise.resolve(next);
  }
}

export function browserOkPayload(
  evaluations: Record<string, EvaluateAllEntry> = BROWSER_EVALUATIONS,
): BrowserEvaluateAllResult {
  return { status: 200, evaluations, etag: '"etag-1"' };
}

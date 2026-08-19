import type { ExposureBatchResponse } from "@splitch/contracts";
import {
  DurableExposureRedemptionClaimStore,
  type ExposureRedemptionClaimNamespace,
} from "./exposure-redemption-claim";
import type { ExposureRedemptionClaimStore } from "./exposure-redemption-claim-core";
import { EXPOSURE_ID_A, exposuresInit, mintTicket, PATH } from "./exposures-test-fixtures";
import { CLIENT_KEY, makeSdkRouteHarness } from "./sdk-route-test-fixtures";

export const REQUEST_ID = "req_spl_366_claim_taxonomy";
export const INNER_CAUSE = "Network connection lost: durable object 7f3a stub reset";
export const BODY_READ_LOST = "Network connection lost";

function fakeNamespace(fetchImpl: () => Promise<Response>): ExposureRedemptionClaimNamespace {
  return {
    idFromName: (name) => ({ toString: () => name }) as DurableObjectId,
    get: () => ({ fetch: async () => fetchImpl() }),
  };
}

/** Path-aware DO stub — claim / markSealed / acknowledge can diverge. */
export function fakeNamespaceByPath(
  handlers: Readonly<Record<string, () => Promise<Response>>>,
): ExposureRedemptionClaimNamespace {
  return {
    idFromName: (name) => ({ toString: () => name }) as DurableObjectId,
    get: () => ({
      fetch: async (input: RequestInfo | URL) => {
        const path = new URL(String(input)).pathname;
        const handler = handlers[path];
        if (!handler) throw new Error(`unexpected DO path ${path}`);
        return handler();
      },
    }),
  };
}

export function jsonOk(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function durableStore(
  fetchImpl: () => Promise<Response>,
): DurableExposureRedemptionClaimStore {
  return new DurableExposureRedemptionClaimStore(fakeNamespace(fetchImpl));
}

export async function redeemWithStore(store: ExposureRedemptionClaimStore): Promise<{
  status: number;
  body: ExposureBatchResponse;
  exposureSink: Awaited<ReturnType<typeof makeSdkRouteHarness>>["exposureSink"];
  logger: Awaited<ReturnType<typeof makeSdkRouteHarness>>["logger"];
}> {
  const { app, exposureSink, logger } = await makeSdkRouteHarness({
    liveRun: true,
    exposureRedemptionClaims: store,
  });
  const ticket = await mintTicket();
  const response = await app.request(
    PATH,
    exposuresInit(CLIENT_KEY, [{ exposureId: EXPOSURE_ID_A, exposureTicket: ticket }], {
      "x-request-id": REQUEST_ID,
    }),
  );
  const body = (await response.json()) as ExposureBatchResponse;
  return { status: response.status, body, exposureSink, logger };
}

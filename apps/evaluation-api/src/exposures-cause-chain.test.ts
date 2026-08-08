import type { ExposureBatchResponse } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import {
  DurableExposureRedemptionClaimStore,
  MemoryExposureRedemptionClaimStore,
  type ExposureRedemptionClaimNamespace,
} from "./exposure-redemption-claim";
import type {
  ExposureRedemptionAcknowledgeOutcome,
  ExposureRedemptionClaimInput,
} from "./exposure-redemption-claim-core";
import {
  ExposureRedemptionClaimProtocolError,
  ExposureRedemptionClaimTransportError,
} from "./exposure-redemption-claim-errors";
import { EXPOSURE_ID_A, exposuresInit, mintTicket, PATH } from "./exposures-test-fixtures";
import { APP_ID, CLIENT_KEY, ENVIRONMENT_ID, makeSdkRouteHarness } from "./sdk-route-test-fixtures";

const REQUEST_ID = "req_spl_366_cause_chain";
const INNER = "underlying durable object reset";

class FailAcknowledgeTransportStore extends MemoryExposureRedemptionClaimStore {
  override async acknowledge(
    _input: ExposureRedemptionClaimInput,
  ): Promise<ExposureRedemptionAcknowledgeOutcome> {
    throw new ExposureRedemptionClaimTransportError(new Error(INNER));
  }
}

class FailAcknowledgeProtocolStore extends MemoryExposureRedemptionClaimStore {
  override async acknowledge(
    _input: ExposureRedemptionClaimInput,
  ): Promise<ExposureRedemptionAcknowledgeOutcome> {
    throw new ExposureRedemptionClaimProtocolError(
      "exposure redemption acknowledge returned an invalid outcome",
    );
  }
}

function fakeNamespaceByPath(
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

describe("exposure redemption logs: causeChain + confirm taxonomy (SPL-366)", () => {
  it("records the nested cause on confirm transport failure", async () => {
    const { app, logger } = await makeSdkRouteHarness({
      liveRun: true,
      exposureRedemptionClaims: new FailAcknowledgeTransportStore(),
    });
    const ticket = await mintTicket();
    const body = (await (
      await app.request(
        PATH,
        exposuresInit(CLIENT_KEY, [{ exposureId: EXPOSURE_ID_A, exposureTicket: ticket }], {
          "x-request-id": REQUEST_ID,
        }),
      )
    ).json()) as ExposureBatchResponse;

    expect(body.results[0]?.code).toBe("SERVICE_UNAVAILABLE");
    expect(logger.errors).toContainEqual({
      message: "exposure_redemption_confirm_failed",
      detail: {
        requestId: REQUEST_ID,
        appId: APP_ID,
        environmentId: ENVIRONMENT_ID,
        exposureId: EXPOSURE_ID_A,
        causeChain: ["exposure redemption claim Durable Object transport failed", INNER],
      },
    });
  });

  it("classifies confirm-path protocol violation as INTERNAL_SERVER_ERROR", async () => {
    const { app, logger } = await makeSdkRouteHarness({
      liveRun: true,
      exposureRedemptionClaims: new FailAcknowledgeProtocolStore(),
    });
    const ticket = await mintTicket();
    const body = (await (
      await app.request(
        PATH,
        exposuresInit(CLIENT_KEY, [{ exposureId: EXPOSURE_ID_A, exposureTicket: ticket }], {
          "x-request-id": REQUEST_ID,
        }),
      )
    ).json()) as ExposureBatchResponse;

    expect(body.results[0]?.code).toBe("INTERNAL_SERVER_ERROR");
    expect(logger.errors).toContainEqual({
      message: "exposure_redemption_confirm_failed",
      detail: {
        requestId: REQUEST_ID,
        appId: APP_ID,
        environmentId: ENVIRONMENT_ID,
        exposureId: EXPOSURE_ID_A,
        causeChain: ["exposure redemption acknowledge returned an invalid outcome"],
      },
    });
  });

  it("classifies Durable acknowledge HTTP 409 on the real store as INTERNAL_SERVER_ERROR", async () => {
    const store = new DurableExposureRedemptionClaimStore(
      fakeNamespaceByPath({
        "/claim": async () =>
          new Response(JSON.stringify({ status: "acquired" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        "/markSealed": async () =>
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        "/acknowledge": async () =>
          new Response(JSON.stringify({ error: "mismatch" }), { status: 409 }),
      }),
    );
    const { app } = await makeSdkRouteHarness({
      liveRun: true,
      exposureRedemptionClaims: store,
    });
    const ticket = await mintTicket();
    const body = (await (
      await app.request(
        PATH,
        exposuresInit(CLIENT_KEY, [{ exposureId: EXPOSURE_ID_A, exposureTicket: ticket }]),
      )
    ).json()) as ExposureBatchResponse;

    expect(body.results[0]?.code).toBe("INTERNAL_SERVER_ERROR");
  });
});

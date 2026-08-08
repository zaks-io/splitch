import type { ExposureBatchResponse } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import {
  DurableExposureRedemptionClaimStore,
  MemoryExposureRedemptionClaimStore,
  type ExposureRedemptionClaimNamespace,
} from "./exposure-redemption-claim";
import type {
  ExposureRedemptionClaimInput,
  ExposureRedemptionClaimOutcome,
  ExposureRedemptionClaimStore,
} from "./exposure-redemption-claim-core";
import {
  EXPOSURE_ID_A,
  EXPOSURE_ID_B,
  EXPOSURE_ID_C,
  exposuresInit,
  mintTicket,
  PATH,
} from "./exposures-test-fixtures";
import { APP_ID, CLIENT_KEY, ENVIRONMENT_ID, makeSdkRouteHarness } from "./sdk-route-test-fixtures";

const REQUEST_ID = "req_spl_366_claim_taxonomy";
const INNER_CAUSE = "Network connection lost: durable object 7f3a stub reset";

function fakeNamespace(fetchImpl: () => Promise<Response>): ExposureRedemptionClaimNamespace {
  return {
    idFromName: (name) => ({ toString: () => name }) as DurableObjectId,
    get: () => ({ fetch: async () => fetchImpl() }),
  };
}

async function redeemWithStore(store: ExposureRedemptionClaimStore): Promise<{
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

describe("POST /api/sdk/exposures: real-store claim faults (SPL-366)", () => {
  it("maps parseClaimOutcome protocol violation through DurableExposureRedemptionClaimStore", async () => {
    // Real rpc path: HTTP 200 + unrecognized body → parseClaimOutcome throw site.
    const store = new DurableExposureRedemptionClaimStore(
      fakeNamespace(
        async () =>
          new Response(JSON.stringify({ status: "nope" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const { body, exposureSink, logger } = await redeemWithStore(store);

    expect(body.results).toEqual([
      { exposureId: EXPOSURE_ID_A, status: "rejected", code: "INTERNAL_SERVER_ERROR" },
    ]);
    expect(exposureSink.writes).toHaveLength(0);
    expect(logger.errors[0]?.detail).toMatchObject({
      causeChain: ["exposure redemption claim returned an invalid outcome"],
    });
  });

  it("maps Durable Object HTTP 400 through DurableExposureRedemptionClaimStore", async () => {
    const store = new DurableExposureRedemptionClaimStore(
      fakeNamespace(async () => new Response("bad request", { status: 400 })),
    );
    const { body, exposureSink, logger } = await redeemWithStore(store);

    expect(body.results).toEqual([
      { exposureId: EXPOSURE_ID_A, status: "rejected", code: "INTERNAL_SERVER_ERROR" },
    ]);
    expect(exposureSink.writes).toHaveLength(0);
    expect(logger.errors[0]?.detail).toMatchObject({
      causeChain: ["exposure redemption claim Durable Object returned HTTP 400"],
    });
  });

  it("maps Durable Object transport throw through DurableExposureRedemptionClaimStore", async () => {
    const store = new DurableExposureRedemptionClaimStore(
      fakeNamespace(async () => {
        throw new Error(INNER_CAUSE);
      }),
    );
    const { body, exposureSink, logger } = await redeemWithStore(store);

    expect(body.results).toEqual([
      { exposureId: EXPOSURE_ID_A, status: "rejected", code: "SERVICE_UNAVAILABLE" },
    ]);
    expect(exposureSink.writes).toHaveLength(0);
    expect(logger.errors).toEqual([
      {
        message: "exposure_redemption_claim_failed",
        detail: {
          requestId: REQUEST_ID,
          appId: APP_ID,
          environmentId: ENVIRONMENT_ID,
          exposureId: EXPOSURE_ID_A,
          causeChain: ["exposure redemption claim Durable Object transport failed", INNER_CAUSE],
        },
      },
    ]);
  });

  it("maps Durable Object HTTP 500 to retryable SERVICE_UNAVAILABLE", async () => {
    const store = new DurableExposureRedemptionClaimStore(
      fakeNamespace(
        async () => new Response(JSON.stringify({ status: "acquired" }), { status: 500 }),
      ),
    );
    const { body } = await redeemWithStore(store);

    expect(body.results).toEqual([
      { exposureId: EXPOSURE_ID_A, status: "rejected", code: "SERVICE_UNAVAILABLE" },
    ]);
  });
});

describe("POST /api/sdk/exposures: programming + sibling claim faults (SPL-366)", () => {
  it("maps TypeError from claim() to non-retryable INTERNAL_SERVER_ERROR", async () => {
    const claims: ExposureRedemptionClaimStore = {
      claim: async () => {
        throw new TypeError("undefined is not a function");
      },
      release: async () => undefined,
      markSealed: async () => undefined,
      acknowledge: async () => ({ status: "accepted" }),
    };
    const { status, body, exposureSink, logger } = await redeemWithStore(claims);

    expect(status).toBe(202);
    expect(body.results).toEqual([
      { exposureId: EXPOSURE_ID_A, status: "rejected", code: "INTERNAL_SERVER_ERROR" },
    ]);
    expect(exposureSink.writes).toHaveLength(0);
    expect(logger.errors).toEqual([
      {
        message: "exposure_redemption_claim_failed",
        detail: {
          requestId: REQUEST_ID,
          appId: APP_ID,
          environmentId: ENVIRONMENT_ID,
          exposureId: EXPOSURE_ID_A,
          causeChain: ["undefined is not a function"],
        },
      },
    ]);
  });

  it("leaves siblings ordered and accepted around a deterministic middle fault", async () => {
    const memory = new MemoryExposureRedemptionClaimStore();
    const claims: ExposureRedemptionClaimStore = {
      async claim(input: ExposureRedemptionClaimInput): Promise<ExposureRedemptionClaimOutcome> {
        if (input.exposureId === EXPOSURE_ID_B) {
          throw new TypeError("undefined is not a function");
        }
        return memory.claim(input);
      },
      release: (input) => memory.release(input),
      markSealed: (input) => memory.markSealed(input),
      acknowledge: (input) => memory.acknowledge(input),
    };
    const { app, exposureSink, assignmentStore } = await makeSdkRouteHarness({
      liveRun: true,
      exposureRedemptionClaims: claims,
    });
    const [ticketA, ticketB, ticketC] = await Promise.all([
      mintTicket({ targetingKey: "entity-a" }),
      mintTicket({ targetingKey: "entity-b" }),
      mintTicket({ targetingKey: "entity-c" }),
    ]);

    const body = (await (
      await app.request(
        PATH,
        exposuresInit(CLIENT_KEY, [
          { exposureId: EXPOSURE_ID_A, exposureTicket: ticketA },
          { exposureId: EXPOSURE_ID_B, exposureTicket: ticketB },
          { exposureId: EXPOSURE_ID_C, exposureTicket: ticketC },
        ]),
      )
    ).json()) as ExposureBatchResponse;

    expect(body.results).toEqual([
      { exposureId: EXPOSURE_ID_A, status: "accepted", code: null },
      { exposureId: EXPOSURE_ID_B, status: "rejected", code: "INTERNAL_SERVER_ERROR" },
      { exposureId: EXPOSURE_ID_C, status: "accepted", code: null },
    ]);
    expect(exposureSink.writes.map(({ eventId }) => eventId)).toEqual([
      EXPOSURE_ID_A,
      EXPOSURE_ID_C,
    ]);
    expect(assignmentStore.putHashedCalls).toHaveLength(2);
  });
});

import type { ExposureBatchResponse } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import {
  DurableExposureRedemptionClaimStore,
  parseClaimOutcome,
} from "./exposure-redemption-claim";
import type {
  ExposureRedemptionClaimInput,
  ExposureRedemptionClaimStore,
} from "./exposure-redemption-claim-core";
import { ExposureRedemptionClaimFault } from "./exposure-redemption-claim-fault";
import {
  EXPOSURE_ID_A,
  EXPOSURE_ID_B,
  EXPOSURE_ID_C,
  exposuresInit,
  mintTicket,
  PATH,
} from "./exposures-test-fixtures";
import { APP_ID, CLIENT_KEY, ENVIRONMENT_ID, makeSdkRouteHarness } from "./sdk-route-test-fixtures";

const REQUEST_ID = "req_spl_366_claim_fault_taxonomy";

function throwingClaimStore(
  thrower: (input: ExposureRedemptionClaimInput) => Promise<never>,
): ExposureRedemptionClaimStore {
  return {
    claim: thrower,
    release: async () => undefined,
    markSealed: async () => undefined,
    acknowledge: async () => ({ status: "accepted" }),
  };
}

describe("POST /api/sdk/exposures: claim fault taxonomy (SPL-366)", () => {
  it("maps a TypeError from claim() to non-retryable INTERNAL_SERVER_ERROR", async () => {
    const { app, exposureSink, logger } = await makeSdkRouteHarness({
      liveRun: true,
      exposureRedemptionClaims: throwingClaimStore(async () => {
        throw new TypeError("undefined is not a function");
      }),
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

  it("maps a parseClaimOutcome protocol violation to INTERNAL_SERVER_ERROR", async () => {
    expect(() => parseClaimOutcome({ status: "nope" })).toThrow(ExposureRedemptionClaimFault);
    const { app, exposureSink } = await makeSdkRouteHarness({
      liveRun: true,
      exposureRedemptionClaims: throwingClaimStore(async () => {
        parseClaimOutcome({ status: "nope" });
        throw new Error("unreachable");
      }),
    });
    const ticket = await mintTicket();
    const body = (await (
      await app.request(
        PATH,
        exposuresInit(CLIENT_KEY, [{ exposureId: EXPOSURE_ID_A, exposureTicket: ticket }]),
      )
    ).json()) as ExposureBatchResponse;

    expect(body.results).toEqual([
      { exposureId: EXPOSURE_ID_A, status: "rejected", code: "INTERNAL_SERVER_ERROR" },
    ]);
    expect(exposureSink.writes).toHaveLength(0);
  });

  it("maps a Durable Object HTTP 400 to INTERNAL_SERVER_ERROR", async () => {
    const store = new DurableExposureRedemptionClaimStore({
      idFromName: (name) => ({ toString: () => name }) as DurableObjectId,
      get: () => ({
        fetch: async () => new Response("bad request", { status: 400 }),
      }),
    });
    const { app, exposureSink } = await makeSdkRouteHarness({
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

    expect(body.results).toEqual([
      { exposureId: EXPOSURE_ID_A, status: "rejected", code: "INTERNAL_SERVER_ERROR" },
    ]);
    expect(exposureSink.writes).toHaveLength(0);
  });

  it("maps a Durable Object transport failure to retryable SERVICE_UNAVAILABLE", async () => {
    const inner = "Network connection lost: durable object stub reset";
    const store = new DurableExposureRedemptionClaimStore({
      idFromName: (name) => ({ toString: () => name }) as DurableObjectId,
      get: () => ({
        fetch: async () => {
          throw new Error(inner);
        },
      }),
    });
    const { app, exposureSink, logger } = await makeSdkRouteHarness({
      liveRun: true,
      exposureRedemptionClaims: store,
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
          causeChain: ["exposure redemption claim Durable Object transport failed", inner],
        },
      },
    ]);
  });
});

describe("POST /api/sdk/exposures: deterministic claim fault siblings (SPL-366)", () => {
  it("keeps siblings accepted when a middle item is a deterministic claim fault", async () => {
    const { MemoryExposureRedemptionClaimStore } = await import("./exposure-redemption-claim");
    const memory = new MemoryExposureRedemptionClaimStore();
    const claimExposureIds: string[] = [];
    const mixed: ExposureRedemptionClaimStore = {
      async claim(input) {
        claimExposureIds.push(input.exposureId);
        if (input.exposureId === EXPOSURE_ID_B) {
          throw new TypeError("undefined is not a function");
        }
        return memory.claim(input);
      },
      release: (input) => memory.release(input),
      markSealed: (input) => memory.markSealed(input),
      acknowledge: (input) => memory.acknowledge(input),
    };
    const { app, assignmentStore, exposureSink } = await makeSdkRouteHarness({
      liveRun: true,
      exposureRedemptionClaims: mixed,
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
    expect(claimExposureIds).toEqual([EXPOSURE_ID_A, EXPOSURE_ID_B, EXPOSURE_ID_C]);
    expect(exposureSink.writes.map(({ eventId }) => eventId)).toEqual([
      EXPOSURE_ID_A,
      EXPOSURE_ID_C,
    ]);
    expect(assignmentStore.putHashedCalls).toHaveLength(2);
  });
});

import type { ExposureBatchResponse } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { MemoryExposureRedemptionClaimStore } from "./exposure-redemption-claim";
import type {
  ExposureRedemptionClaimInput,
  ExposureRedemptionClaimOutcome,
  ExposureRedemptionClaimStore,
} from "./exposure-redemption-claim-core";
import { redeemWithStore, REQUEST_ID } from "./exposures-claim-fault-fixtures";
import {
  EXPOSURE_ID_A,
  EXPOSURE_ID_B,
  EXPOSURE_ID_C,
  exposuresInit,
  mintTicket,
  PATH,
} from "./exposures-test-fixtures";
import { APP_ID, CLIENT_KEY, ENVIRONMENT_ID, makeSdkRouteHarness } from "./sdk-route-test-fixtures";

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

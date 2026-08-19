import type { ExposureBatchResponse } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { MemoryExposureRedemptionClaimStore } from "./exposure-redemption-claim";
import { ExposureRedemptionClaimTransportError } from "./exposure-redemption-claim-errors";
import type {
  ExposureRedemptionClaimInput,
  ExposureRedemptionClaimOutcome,
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

const REQUEST_ID = "req_spl_347_mixed_claim_failure";
const INNER_CAUSE = "Network connection lost: durable object 7f3a stub reset";

class MiddleClaimFailureStore extends MemoryExposureRedemptionClaimStore {
  readonly claimExposureIds: string[] = [];

  override claim(input: ExposureRedemptionClaimInput): Promise<ExposureRedemptionClaimOutcome> {
    this.claimExposureIds.push(input.exposureId);
    if (input.exposureId === EXPOSURE_ID_B) {
      return Promise.reject(new ExposureRedemptionClaimTransportError(new Error(INNER_CAUSE)));
    }
    return super.claim(input);
  }
}

describe("POST /api/sdk/exposures: per-item claim failure", () => {
  it("rejects a middle claim fault and preserves ordered sibling acknowledgements", async () => {
    const claims = new MiddleClaimFailureStore();
    const { app, assignmentStore, exposureSink, logger } = await makeSdkRouteHarness({
      liveRun: true,
      exposureRedemptionClaims: claims,
    });
    const [ticketA, ticketB, ticketC] = await Promise.all([
      mintTicket({ targetingKey: "entity-a" }),
      mintTicket({ targetingKey: "entity-b" }),
      mintTicket({ targetingKey: "entity-c" }),
    ]);

    const response = await app.request(
      PATH,
      exposuresInit(
        CLIENT_KEY,
        [
          { exposureId: EXPOSURE_ID_A, exposureTicket: ticketA },
          { exposureId: EXPOSURE_ID_B, exposureTicket: ticketB },
          { exposureId: EXPOSURE_ID_C, exposureTicket: ticketC },
        ],
        { "x-request-id": REQUEST_ID },
      ),
    );
    const body = (await response.json()) as ExposureBatchResponse;

    expect(response.status).toBe(202);
    expect(body.results).toEqual([
      { exposureId: EXPOSURE_ID_A, status: "accepted", code: null },
      { exposureId: EXPOSURE_ID_B, status: "rejected", code: "SERVICE_UNAVAILABLE" },
      { exposureId: EXPOSURE_ID_C, status: "accepted", code: null },
    ]);
    expect(claims.claimExposureIds).toEqual([EXPOSURE_ID_A, EXPOSURE_ID_B, EXPOSURE_ID_C]);
    expect(exposureSink.writes.map(({ eventId }) => eventId)).toEqual([
      EXPOSURE_ID_A,
      EXPOSURE_ID_C,
    ]);
    expect(assignmentStore.putHashedCalls).toHaveLength(2);
    expect(logger.errors).toEqual([
      {
        message: "exposure_redemption_claim_failed",
        detail: {
          requestId: REQUEST_ID,
          appId: APP_ID,
          environmentId: ENVIRONMENT_ID,
          exposureId: EXPOSURE_ID_B,
          causeChain: ["exposure redemption claim Durable Object transport failed", INNER_CAUSE],
        },
      },
    ]);
  });
});

import type { ExposureBatchResponse } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { MemoryExposureRedemptionClaimStore } from "./exposure-redemption-claim";
import { ExposureRedemptionClaimTransportError } from "./exposure-redemption-claim-errors";
import type {
  ExposureRedemptionAcknowledgeOutcome,
  ExposureRedemptionClaimInput,
} from "./exposure-redemption-claim-core";
import { EXPOSURE_ID_A, exposuresInit, mintTicket, PATH } from "./exposures-test-fixtures";
import { APP_ID, CLIENT_KEY, ENVIRONMENT_ID, makeSdkRouteHarness } from "./sdk-route-test-fixtures";

const REQUEST_ID = "req_spl_366_cause_chain";
const INNER = "underlying durable object reset";

class FailAcknowledgeStore extends MemoryExposureRedemptionClaimStore {
  override async acknowledge(
    _input: ExposureRedemptionClaimInput,
  ): Promise<ExposureRedemptionAcknowledgeOutcome> {
    throw new ExposureRedemptionClaimTransportError(new Error(INNER));
  }
}

describe("exposure redemption logs: causeChain (SPL-366)", () => {
  it("records the nested cause on confirm failure, not only the outer constant", async () => {
    const { app, logger } = await makeSdkRouteHarness({
      liveRun: true,
      exposureRedemptionClaims: new FailAcknowledgeStore(),
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
});

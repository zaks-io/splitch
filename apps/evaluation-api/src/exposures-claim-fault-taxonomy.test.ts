import type { ExposureBatchResponse } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { MemoryExposureRedemptionClaimStore } from "./exposure-redemption-claim";
import {
  ExposureRedemptionClaimHttpError,
  ExposureRedemptionClaimProtocolError,
  ExposureRedemptionClaimTransportError,
} from "./exposure-redemption-claim-errors";
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

const REQUEST_ID = "req_spl_366_claim_taxonomy";
const INNER_CAUSE = "Network connection lost: durable object 7f3a stub reset";

class ThrowingClaimStore extends MemoryExposureRedemptionClaimStore {
  constructor(private readonly fault: (input: ExposureRedemptionClaimInput) => never) {
    super();
  }

  override claim(input: ExposureRedemptionClaimInput): Promise<ExposureRedemptionClaimOutcome> {
    this.fault(input);
  }
}

async function redeemOne(
  claims: MemoryExposureRedemptionClaimStore,
  exposureId: string = EXPOSURE_ID_A,
): Promise<{
  response: Response;
  body: ExposureBatchResponse;
  logger: { errors: Array<{ message: string; detail: unknown }> };
  exposureSink: { writes: unknown[] };
}> {
  const { app, exposureSink, logger } = await makeSdkRouteHarness({
    liveRun: true,
    exposureRedemptionClaims: claims,
  });
  const ticket = await mintTicket();
  const response = await app.request(
    PATH,
    exposuresInit(CLIENT_KEY, [{ exposureId, exposureTicket: ticket }], {
      "x-request-id": REQUEST_ID,
    }),
  );
  const body = (await response.json()) as ExposureBatchResponse;
  return { response, body, logger, exposureSink };
}

describe("POST /api/sdk/exposures: claim fault taxonomy (SPL-366)", () => {
  it("maps TypeError from claim() to non-retryable INTERNAL_SERVER_ERROR", async () => {
    const { response, body, exposureSink, logger } = await redeemOne(
      new ThrowingClaimStore(() => {
        throw new TypeError("undefined is not a function");
      }),
    );

    expect(response.status).toBe(202);
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

  it("maps parseClaimOutcome protocol violation to INTERNAL_SERVER_ERROR", async () => {
    const { response, body, logger } = await redeemOne(
      new ThrowingClaimStore(() => {
        throw new ExposureRedemptionClaimProtocolError(
          "exposure redemption claim returned an invalid outcome",
        );
      }),
    );

    expect(response.status).toBe(202);
    expect(body.results).toEqual([
      { exposureId: EXPOSURE_ID_A, status: "rejected", code: "INTERNAL_SERVER_ERROR" },
    ]);
    expect(logger.errors[0]?.detail).toMatchObject({
      causeChain: ["exposure redemption claim returned an invalid outcome"],
    });
  });

  it("maps Durable Object HTTP 400 to INTERNAL_SERVER_ERROR", async () => {
    const { response, body, logger } = await redeemOne(
      new ThrowingClaimStore(() => {
        throw new ExposureRedemptionClaimHttpError(400);
      }),
    );

    expect(response.status).toBe(202);
    expect(body.results).toEqual([
      { exposureId: EXPOSURE_ID_A, status: "rejected", code: "INTERNAL_SERVER_ERROR" },
    ]);
    expect(logger.errors[0]?.detail).toMatchObject({
      causeChain: ["exposure redemption claim Durable Object returned HTTP 400"],
    });
  });

  it("maps Durable Object transport failure to retryable SERVICE_UNAVAILABLE", async () => {
    const { response, body, logger } = await redeemOne(
      new ThrowingClaimStore(() => {
        throw new ExposureRedemptionClaimTransportError(new Error(INNER_CAUSE));
      }),
    );

    expect(response.status).toBe(202);
    expect(body.results).toEqual([
      { exposureId: EXPOSURE_ID_A, status: "rejected", code: "SERVICE_UNAVAILABLE" },
    ]);
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

  it("leaves siblings ordered and accepted around a deterministic middle fault", async () => {
    const claims = new (class extends MemoryExposureRedemptionClaimStore {
      override claim(input: ExposureRedemptionClaimInput): Promise<ExposureRedemptionClaimOutcome> {
        if (input.exposureId === EXPOSURE_ID_B) {
          return Promise.reject(new TypeError("undefined is not a function"));
        }
        return super.claim(input);
      }
    })();
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

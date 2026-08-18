import { describe, expect, it } from "vitest";
import {
  BODY_READ_LOST,
  durableStore,
  INNER_CAUSE,
  REQUEST_ID,
  redeemWithStore,
} from "./exposures-claim-fault-fixtures";
import { EXPOSURE_ID_A } from "./exposures-test-fixtures";
import { APP_ID, ENVIRONMENT_ID } from "./sdk-route-test-fixtures";

describe("POST /api/sdk/exposures: real-store claim faults (SPL-366)", () => {
  it("maps parseClaimOutcome protocol violation through DurableExposureRedemptionClaimStore", async () => {
    const { body, exposureSink, logger } = await redeemWithStore(
      durableStore(
        async () =>
          new Response(JSON.stringify({ status: "nope" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    expect(body.results).toEqual([
      { exposureId: EXPOSURE_ID_A, status: "rejected", code: "INTERNAL_SERVER_ERROR" },
    ]);
    expect(exposureSink.writes).toHaveLength(0);
    expect(logger.errors[0]?.detail).toMatchObject({
      causeChain: ["exposure redemption claim returned an invalid outcome"],
    });
  });

  it("maps non-JSON HTTP 200 body to INTERNAL_SERVER_ERROR (protocol, not transport)", async () => {
    const { body, exposureSink, logger } = await redeemWithStore(
      durableStore(async () => new Response("<html>oops</html>", { status: 200 })),
    );

    expect(body.results).toEqual([
      { exposureId: EXPOSURE_ID_A, status: "rejected", code: "INTERNAL_SERVER_ERROR" },
    ]);
    expect(exposureSink.writes).toHaveLength(0);
    expect(logger.errors[0]?.detail).toMatchObject({
      causeChain: expect.arrayContaining(["exposure redemption claim returned an invalid outcome"]),
    });
  });

  it("maps Durable Object HTTP 400 through DurableExposureRedemptionClaimStore", async () => {
    const { body, exposureSink, logger } = await redeemWithStore(
      durableStore(async () => new Response("bad request", { status: 400 })),
    );

    expect(body.results).toEqual([
      { exposureId: EXPOSURE_ID_A, status: "rejected", code: "INTERNAL_SERVER_ERROR" },
    ]);
    expect(exposureSink.writes).toHaveLength(0);
    expect(logger.errors[0]?.detail).toMatchObject({
      causeChain: ["exposure redemption claim Durable Object returned HTTP 400"],
    });
  });

  it("maps Durable Object HTTP 404 on claim to INTERNAL_SERVER_ERROR", async () => {
    const { body } = await redeemWithStore(
      durableStore(
        async () => new Response(JSON.stringify({ error: "not found" }), { status: 404 }),
      ),
    );
    expect(body.results).toEqual([
      { exposureId: EXPOSURE_ID_A, status: "rejected", code: "INTERNAL_SERVER_ERROR" },
    ]);
  });

  it("maps platform-injected HTTP 429 to retryable SERVICE_UNAVAILABLE", async () => {
    const { body } = await redeemWithStore(
      durableStore(async () => new Response("rate limited", { status: 429 })),
    );
    expect(body.results).toEqual([
      { exposureId: EXPOSURE_ID_A, status: "rejected", code: "SERVICE_UNAVAILABLE" },
    ]);
  });

  it("maps platform-injected HTTP 408 to retryable SERVICE_UNAVAILABLE", async () => {
    const { body } = await redeemWithStore(
      durableStore(async () => new Response("timeout", { status: 408 })),
    );
    expect(body.results).toEqual([
      { exposureId: EXPOSURE_ID_A, status: "rejected", code: "SERVICE_UNAVAILABLE" },
    ]);
  });

  it("maps Durable Object transport throw through DurableExposureRedemptionClaimStore", async () => {
    const { body, exposureSink, logger } = await redeemWithStore(
      durableStore(async () => {
        throw new Error(INNER_CAUSE);
      }),
    );

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

  it("maps body-read failure after HTTP 200 to retryable SERVICE_UNAVAILABLE", async () => {
    const { body, exposureSink, logger } = await redeemWithStore(
      durableStore(async () => {
        const response = new Response(JSON.stringify({ status: "acquired" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
        response.json = async () => {
          throw new TypeError(BODY_READ_LOST);
        };
        return response;
      }),
    );

    expect(body.results).toEqual([
      { exposureId: EXPOSURE_ID_A, status: "rejected", code: "SERVICE_UNAVAILABLE" },
    ]);
    expect(exposureSink.writes).toHaveLength(0);
    expect(logger.errors[0]?.detail).toMatchObject({
      causeChain: ["exposure redemption claim Durable Object transport failed", BODY_READ_LOST],
    });
  });

  it("maps Durable Object HTTP 500 to retryable SERVICE_UNAVAILABLE", async () => {
    const { body } = await redeemWithStore(
      durableStore(
        async () =>
          new Response(JSON.stringify({ status: "acquired" }), {
            status: 500,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    expect(body.results).toEqual([
      { exposureId: EXPOSURE_ID_A, status: "rejected", code: "SERVICE_UNAVAILABLE" },
    ]);
  });
});

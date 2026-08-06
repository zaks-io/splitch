import type { ExposureBatchResponse } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { MemoryExposureRedemptionClaimStore } from "./exposure-redemption";
import { EXPOSURE_ID_A, exposuresInit, mintTicket, PATH } from "./exposures-test-fixtures";
import {
  APP_ID,
  CLIENT_KEY,
  ENVIRONMENT_ID,
  EXPERIMENT_ID,
  makeSdkRouteHarness,
} from "./sdk-route-test-fixtures";

describe("POST /api/sdk/exposures: happy path and pipeline seam", () => {
  it("accepts a valid ticket, seals a shape-identical Exposure, and puts the holdover", async () => {
    const { app, assignmentStore, exposureSink } = await makeSdkRouteHarness({
      liveRun: true,
    });
    const ticket = await mintTicket();

    const res = await app.request(
      PATH,
      exposuresInit(CLIENT_KEY, [{ exposureId: EXPOSURE_ID_A, exposureTicket: ticket }]),
    );
    const body = (await res.json()) as ExposureBatchResponse;

    expect(res.status).toBe(202);
    expect(body.results).toEqual([{ exposureId: EXPOSURE_ID_A, status: "accepted", code: null }]);
    // Same AssembledExposure shape evaluate seals; append path proven in exposures-seam.test.ts.
    expect(exposureSink.writes).toHaveLength(1);
    expect(exposureSink.writes[0]).toMatchObject({
      appId: APP_ID,
      environmentId: ENVIRONMENT_ID,
      experimentId: EXPERIMENT_ID,
      runId: "run-42",
      variantName: "treatment",
      type: "exposure",
      eventId: EXPOSURE_ID_A,
      isHoldover: false,
      counterfactual: false,
    });
    expect(assignmentStore.putHashedCalls).toEqual([
      {
        appId: APP_ID,
        experimentId: EXPERIMENT_ID,
        idType: "user",
        targetingKeyHash: exposureSink.writes[0]?.targetingKeyHash,
        runId: "run-42",
        variant: "treatment",
      },
    ]);
  });

  it("returns deduplicated on an exact exposureId retry and does not append a second row", async () => {
    const claims = new MemoryExposureRedemptionClaimStore();
    const { app, exposureSink } = await makeSdkRouteHarness({
      liveRun: true,
      exposureRedemptionClaims: claims,
    });
    const ticket = await mintTicket();
    const init = exposuresInit(CLIENT_KEY, [{ exposureId: EXPOSURE_ID_A, exposureTicket: ticket }]);

    const first = await app.request(PATH, init);
    const second = await app.request(PATH, init);
    const secondBody = (await second.json()) as ExposureBatchResponse;

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(secondBody.results).toEqual([
      { exposureId: EXPOSURE_ID_A, status: "deduplicated", code: null },
    ]);
    expect(exposureSink.writes).toHaveLength(1);
  });
});

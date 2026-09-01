import type { ExposureBatchResponse } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { EXPOSURE_ID_A, exposuresInit, mintTicket, PATH } from "./exposures-test-fixtures";
import { CLIENT_KEY, makeSdkRouteHarness } from "./sdk-route-test-fixtures";

describe("POST /api/sdk/exposures: source identity", () => {
  it("releases a claim after source failure so the exact-ID retry can append", async () => {
    let sourceAttempts = 0;
    const { app, exposureSink, logger } = await makeSdkRouteHarness({
      liveRun: true,
      exposureSourceId: () => {
        sourceAttempts += 1;
        if (sourceAttempts === 1) {
          throw new Error("Exposure source identity is unavailable");
        }
        return "pop-recovered";
      },
    });
    const ticket = await mintTicket();
    const init = exposuresInit(CLIENT_KEY, [{ exposureId: EXPOSURE_ID_A, exposureTicket: ticket }]);

    expect(
      ((await (await app.request(PATH, init)).json()) as ExposureBatchResponse).results,
    ).toEqual([{ exposureId: EXPOSURE_ID_A, status: "rejected", code: "SERVICE_UNAVAILABLE" }]);
    expect(exposureSink.writes).toHaveLength(0);

    expect(
      ((await (await app.request(PATH, init)).json()) as ExposureBatchResponse).results,
    ).toEqual([{ exposureId: EXPOSURE_ID_A, status: "accepted", code: null }]);
    expect(exposureSink.writes).toHaveLength(1);
    expect(exposureSink.writes[0]?.sourceId).toBe("pop-recovered");
    expect(logger.errors).toContainEqual({
      message: "exposure_source_identity_failed",
      detail: expect.objectContaining({ exposureId: EXPOSURE_ID_A }),
    });
  });
});

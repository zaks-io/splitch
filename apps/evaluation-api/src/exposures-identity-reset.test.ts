import type { ExposureBatchResponse } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { StaticSaltStore } from "./assignment/assignment-store-test-fixtures";
import { mintExposureTicket } from "./evaluate/exposure-ticket";
import { EXPOSURE_ID_A, exposuresInit, PATH } from "./exposures-test-fixtures";
import {
  APP_ID,
  CLIENT_KEY,
  ENVIRONMENT_ID,
  EXPERIMENT_ID,
  makeSdkRouteHarness,
} from "./sdk-route-test-fixtures";

describe("POST /api/sdk/exposures identity reset", () => {
  it("rejects a ticket admitted under the identity generation replaced by reset", async () => {
    class SwitchableSaltStore extends StaticSaltStore {
      version = "app-v1";
      override currentKeyVersion(): Promise<string> {
        return Promise.resolve(this.version);
      }
    }
    const saltStore = new SwitchableSaltStore();
    const ticket = await mintExposureTicket(
      {
        appId: APP_ID,
        environmentId: ENVIRONMENT_ID,
        experimentId: EXPERIMENT_ID,
        flagKey: "checkout-banner",
        idType: "user",
        liveRunId: "run-42",
        targetingKey: "user-1",
        variant: "treatment",
      },
      {
        saltStore,
        ticketKey: "test-exposure-ticket-key".padEnd(32, "x"),
        now: () => new Date("2026-07-03T00:00:00.000Z"),
      },
    );
    saltStore.version = "app-v2";
    const { app, exposureSink } = await makeSdkRouteHarness({ liveRun: true, saltStore });

    const response = await app.request(
      PATH,
      exposuresInit(CLIENT_KEY, [{ exposureId: EXPOSURE_ID_A, exposureTicket: ticket }]),
    );

    expect((await response.json()) as ExposureBatchResponse).toEqual({
      results: [{ exposureId: EXPOSURE_ID_A, status: "rejected", code: "EXPOSURE_TICKET_INVALID" }],
    });
    expect(exposureSink.writes).toHaveLength(0);
  });
});

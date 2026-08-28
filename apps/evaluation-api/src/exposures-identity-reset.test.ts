import type { ExposureBatchResponse } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { StaticSaltStore } from "./assignment/assignment-store-test-fixtures";
import { mintExposureTicket } from "./evaluate/exposure-ticket";
import { EXPOSURE_ID_A, exposuresInit, mintTicket, PATH } from "./exposures-test-fixtures";
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
        ticketKey: ["splitch-test-exposure-ticket-key", "32chars"].join("-"),
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

  it("rejects redemption paused after admission and before downstream delivery", async () => {
    const ticket = await mintTicket();
    const saltStore = new RedemptionPausingSaltStore();
    const { app, exposureSink, assignmentStore } = await makeSdkRouteHarness({
      liveRun: true,
      saltStore,
    });

    const response = Promise.resolve(
      app.request(
        PATH,
        exposuresInit(CLIENT_KEY, [{ exposureId: EXPOSURE_ID_A, exposureTicket: ticket }]),
      ),
    );
    const first = await Promise.race([
      saltStore.paused.then(() => null),
      response.then((completed) => completed.clone()),
    ]);
    expect(first).toBeNull();
    saltStore.replaceIdentity();

    expect((await (await response).json()) as ExposureBatchResponse).toEqual({
      results: [
        {
          exposureId: EXPOSURE_ID_A,
          status: "rejected",
          code: "SERVICE_UNAVAILABLE",
        },
      ],
    });
    expect(exposureSink.writes).toEqual([]);
    expect(assignmentStore.putHashedCalls).toEqual([]);
  });
});

class VersionedSaltStore extends StaticSaltStore {
  constructor(protected version: string) {
    super();
  }

  override currentKeyVersion(): Promise<string> {
    return Promise.resolve(this.version);
  }
}

class RedemptionPausingSaltStore extends VersionedSaltStore {
  private calls = 0;
  private resume!: () => void;
  private entered!: () => void;
  private readonly gate = new Promise<void>((resolve) => {
    this.resume = resolve;
  });
  readonly paused = new Promise<void>((resolve) => {
    this.entered = resolve;
  });

  constructor() {
    super("v1");
  }

  override async currentKeyVersion(): Promise<string> {
    this.calls += 1;
    if (this.calls === 2) {
      this.entered();
      await this.gate;
    }
    return super.currentKeyVersion();
  }

  replaceIdentity(): void {
    this.version = "app-v2";
    this.resume();
  }
}

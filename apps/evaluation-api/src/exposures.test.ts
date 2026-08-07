import type { ExposureBatchResponse } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import {
  type ExposureRedemptionClaimStore,
  type ExposureRedemptionLookup,
  MemoryExposureRedemptionClaimStore,
} from "./exposure-redemption";
import { EXPOSURE_ID_A, exposuresInit, mintTicket, PATH } from "./exposures-test-fixtures";
import {
  APP_ID,
  CLIENT_KEY,
  ENVIRONMENT_ID,
  EXPERIMENT_ID,
  makeSdkRouteHarness,
} from "./sdk-route-test-fixtures";

/** Simulates KvExposureRedemptionClaimStore when the ticket-fingerprint put fails. */
class PartialTicketClaimStore implements ExposureRedemptionClaimStore {
  private readonly byExposureId = new Map<string, string>();

  async lookup(input: {
    readonly appId: string;
    readonly environmentId: string;
    readonly exposureId: string;
    readonly ticketFingerprint: string;
  }): Promise<ExposureRedemptionLookup> {
    const existing = this.byExposureId.get(
      `${input.appId}\u001f${input.environmentId}\u001f${input.exposureId}`,
    );
    if (existing !== undefined) {
      return existing === input.ticketFingerprint ? { status: "matched" } : { status: "conflict" };
    }
    return { status: "missing" };
  }

  async record(input: {
    readonly appId: string;
    readonly environmentId: string;
    readonly exposureId: string;
    readonly ticketFingerprint: string;
  }): Promise<void> {
    this.byExposureId.set(
      `${input.appId}\u001f${input.environmentId}\u001f${input.exposureId}`,
      input.ticketFingerprint,
    );
    throw new Error("ticket fingerprint KV put failed");
  }
}

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

  it("schedules holdover when the ticket-fingerprint claim put fails after ingest", async () => {
    const { app, assignmentStore, exposureSink } = await makeSdkRouteHarness({
      liveRun: true,
      exposureRedemptionClaims: new PartialTicketClaimStore(),
    });
    const ticket = await mintTicket();
    const init = exposuresInit(CLIENT_KEY, [{ exposureId: EXPOSURE_ID_A, exposureTicket: ticket }]);

    const first = await app.request(PATH, init);
    const firstBody = (await first.json()) as ExposureBatchResponse;
    expect(first.status).toBe(202);
    expect(firstBody.results).toEqual([
      { exposureId: EXPOSURE_ID_A, status: "rejected", code: "SERVICE_UNAVAILABLE" },
    ]);
    expect(exposureSink.writes).toHaveLength(1);
    // Ingest committed — holdover must still run even though the claim failed.
    expect(assignmentStore.putHashedCalls).toHaveLength(1);

    const second = await app.request(PATH, init);
    const secondBody = (await second.json()) as ExposureBatchResponse;
    expect(secondBody.results).toEqual([
      { exposureId: EXPOSURE_ID_A, status: "deduplicated", code: null },
    ]);
    expect(exposureSink.writes).toHaveLength(1);
    // Dedup path re-schedules the idempotent put (covers a first attempt that
    // never reached scheduleHoldoverWrite).
    expect(assignmentStore.putHashedCalls).toHaveLength(2);
  });
});

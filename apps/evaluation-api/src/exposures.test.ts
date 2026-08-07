import type { ExposureBatchResponse } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import type { AssembledExposure } from "./evaluate/exposure-assembly";
import { type ExposureIngestSink, ExposureIngestSinkError } from "./exposure-redemption";
import {
  type ExposureRedemptionAcknowledgeOutcome,
  type ExposureRedemptionClaimInput,
  type ExposureRedemptionClaimOutcome,
  type ExposureRedemptionClaimStore,
  MemoryExposureRedemptionClaimStore,
} from "./exposure-redemption-claim";
import { EXPOSURE_ID_A, exposuresInit, mintTicket, PATH } from "./exposures-test-fixtures";
import {
  APP_ID,
  CLIENT_KEY,
  ENVIRONMENT_ID,
  EXPERIMENT_ID,
  makeSdkRouteHarness,
} from "./sdk-route-test-fixtures";

/**
 * Wraps the memory store and fails the first acknowledge so ingest can land
 * while the claim remains pending for an exact-ID resume.
 */
class FailOnceAcknowledgeStore implements ExposureRedemptionClaimStore {
  private acknowledgeAttempts = 0;
  private readonly inner = new MemoryExposureRedemptionClaimStore();

  async claim(input: ExposureRedemptionClaimInput): Promise<ExposureRedemptionClaimOutcome> {
    return this.inner.claim(input);
  }

  async acknowledge(
    input: ExposureRedemptionClaimInput,
  ): Promise<ExposureRedemptionAcknowledgeOutcome> {
    this.acknowledgeAttempts += 1;
    if (this.acknowledgeAttempts === 1) {
      throw new Error("acknowledge Durable Object put failed");
    }
    return this.inner.acknowledge(input);
  }
}

/** Ingest sink that fails once, then succeeds — pending claim must survive. */
class FailOnceIngestSink implements ExposureIngestSink {
  readonly writes: AssembledExposure[] = [];
  private attempts = 0;

  async write(exposure: AssembledExposure): Promise<void> {
    this.attempts += 1;
    if (this.attempts === 1) {
      throw new ExposureIngestSinkError("transient ingest failure", { status: 503 });
    }
    this.writes.push(exposure);
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

  it("resumes a pending claim after acknowledge fails post-ingest", async () => {
    const claims = new FailOnceAcknowledgeStore();
    const { app, assignmentStore, exposureSink } = await makeSdkRouteHarness({
      liveRun: true,
      exposureRedemptionClaims: claims,
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
    // Ingest committed — holdover must still run even though acknowledge failed.
    expect(assignmentStore.putHashedCalls).toHaveLength(1);

    const second = await app.request(PATH, init);
    const secondBody = (await second.json()) as ExposureBatchResponse;
    expect(secondBody.results).toEqual([
      { exposureId: EXPOSURE_ID_A, status: "accepted", code: null },
    ]);
    // Resume re-seals (pipeline first-touch is authoritative) then acknowledges.
    expect(exposureSink.writes).toHaveLength(2);
    expect(assignmentStore.putHashedCalls).toHaveLength(2);
  });

  it("completes an exact-ID retry after transient ingest failure without permanent suppression", async () => {
    const claims = new MemoryExposureRedemptionClaimStore();
    const failOnce = new FailOnceIngestSink();
    const { app } = await makeSdkRouteHarness({
      liveRun: true,
      exposureRedemptionClaims: claims,
      exposureIngestSink: failOnce,
    });
    const ticket = await mintTicket();
    const init = exposuresInit(CLIENT_KEY, [{ exposureId: EXPOSURE_ID_A, exposureTicket: ticket }]);

    const first = await app.request(PATH, init);
    const firstBody = (await first.json()) as ExposureBatchResponse;
    expect(firstBody.results).toEqual([
      { exposureId: EXPOSURE_ID_A, status: "rejected", code: "SERVICE_UNAVAILABLE" },
    ]);
    expect(failOnce.writes).toHaveLength(0);

    const second = await app.request(PATH, init);
    const secondBody = (await second.json()) as ExposureBatchResponse;
    expect(secondBody.results).toEqual([
      { exposureId: EXPOSURE_ID_A, status: "accepted", code: null },
    ]);
    expect(failOnce.writes).toHaveLength(1);
  });
});

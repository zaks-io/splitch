import type { ExposureBatchResponse } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import type { AssembledExposure } from "./evaluate/exposure-assembly";
import { type ExposureIngestSink, ExposureIngestSinkError } from "./exposure-redemption";
import { MemoryExposureRedemptionClaimStore } from "./exposure-redemption-claim";
import type {
  ExposureRedemptionAcknowledgeOutcome,
  ExposureRedemptionClaimInput,
  ExposureRedemptionClaimOutcome,
  ExposureRedemptionClaimStore,
} from "./exposure-redemption-claim-core";
import {
  EXPOSURE_ID_A,
  EXPOSURE_ID_B,
  exposuresInit,
  mintTicket,
  PATH,
} from "./exposures-test-fixtures";
import {
  APP_ID,
  CLIENT_KEY,
  ENVIRONMENT_ID,
  EXPERIMENT_ID,
  makeSdkRouteHarness,
} from "./sdk-route-test-fixtures";

class FailOnceAcknowledgeStore implements ExposureRedemptionClaimStore {
  private acknowledgeAttempts = 0;
  private readonly inner = new MemoryExposureRedemptionClaimStore();

  claim(input: ExposureRedemptionClaimInput): Promise<ExposureRedemptionClaimOutcome> {
    return this.inner.claim(input);
  }
  release(input: ExposureRedemptionClaimInput): Promise<void> {
    return this.inner.release(input);
  }
  markSealed(input: ExposureRedemptionClaimInput): Promise<void> {
    return this.inner.markSealed(input);
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

/** Gates the first write until `release()` so concurrent requests can race claim. */
class GatedIngestSink implements ExposureIngestSink {
  readonly writes: AssembledExposure[] = [];
  private readonly waiters: Array<() => void> = [];
  private open = false;

  release(): void {
    this.open = true;
    for (const resolve of this.waiters.splice(0)) resolve();
  }

  async write(exposure: AssembledExposure): Promise<void> {
    if (!this.open) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.writes.push(exposure);
  }
}

describe("POST /api/sdk/exposures: happy path and pipeline seam", () => {
  it("accepts a valid ticket, seals a shape-identical Exposure, and puts the holdover", async () => {
    const { app, assignmentStore, exposureSink } = await makeSdkRouteHarness({ liveRun: true });
    const ticket = await mintTicket();
    const res = await app.request(
      PATH,
      exposuresInit(CLIENT_KEY, [{ exposureId: EXPOSURE_ID_A, exposureTicket: ticket }]),
    );
    const body = (await res.json()) as ExposureBatchResponse;
    expect(res.status).toBe(202);
    expect(body.results).toEqual([{ exposureId: EXPOSURE_ID_A, status: "accepted", code: null }]);
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
    expect(assignmentStore.putHashedCalls).toHaveLength(1);
  });

  it("returns deduplicated on an exact exposureId retry and does not append a second row", async () => {
    const claims = new MemoryExposureRedemptionClaimStore();
    const { app, exposureSink } = await makeSdkRouteHarness({
      liveRun: true,
      exposureRedemptionClaims: claims,
    });
    const ticket = await mintTicket();
    const init = exposuresInit(CLIENT_KEY, [{ exposureId: EXPOSURE_ID_A, exposureTicket: ticket }]);
    await app.request(PATH, init);
    const second = await app.request(PATH, init);
    expect((await second.json()) as ExposureBatchResponse).toEqual({
      results: [{ exposureId: EXPOSURE_ID_A, status: "deduplicated", code: null }],
    });
    expect(exposureSink.writes).toHaveLength(1);
  });

  it("acknowledges without re-appending after markSealed when acknowledge fails once", async () => {
    const claims = new FailOnceAcknowledgeStore();
    const { app, assignmentStore, exposureSink } = await makeSdkRouteHarness({
      liveRun: true,
      exposureRedemptionClaims: claims,
    });
    const ticket = await mintTicket();
    const init = exposuresInit(CLIENT_KEY, [{ exposureId: EXPOSURE_ID_A, exposureTicket: ticket }]);

    const firstBody = (await (await app.request(PATH, init)).json()) as ExposureBatchResponse;
    expect(firstBody.results).toEqual([
      { exposureId: EXPOSURE_ID_A, status: "rejected", code: "SERVICE_UNAVAILABLE" },
    ]);
    expect(exposureSink.writes).toHaveLength(1);
    expect(assignmentStore.putHashedCalls).toHaveLength(1);

    const secondBody = (await (await app.request(PATH, init)).json()) as ExposureBatchResponse;
    expect(secondBody.results).toEqual([
      { exposureId: EXPOSURE_ID_A, status: "accepted", code: null },
    ]);
    // resume_ack path — no second append.
    expect(exposureSink.writes).toHaveLength(1);
    expect(assignmentStore.putHashedCalls).toHaveLength(2);
  });

  it("releases on ingest failure so an exact-ID retry can acquire and append once", async () => {
    const claims = new MemoryExposureRedemptionClaimStore();
    const failOnce = new FailOnceIngestSink();
    const { app } = await makeSdkRouteHarness({
      liveRun: true,
      exposureRedemptionClaims: claims,
      exposureIngestSink: failOnce,
    });
    const ticket = await mintTicket();
    const init = exposuresInit(CLIENT_KEY, [{ exposureId: EXPOSURE_ID_A, exposureTicket: ticket }]);
    expect(
      ((await (await app.request(PATH, init)).json()) as ExposureBatchResponse).results,
    ).toEqual([{ exposureId: EXPOSURE_ID_A, status: "rejected", code: "SERVICE_UNAVAILABLE" }]);
    expect(failOnce.writes).toHaveLength(0);
    expect(
      ((await (await app.request(PATH, init)).json()) as ExposureBatchResponse).results,
    ).toEqual([{ exposureId: EXPOSURE_ID_A, status: "accepted", code: null }]);
    expect(failOnce.writes).toHaveLength(1);
  });
});

describe("POST /api/sdk/exposures: claim failure and concurrency", () => {
  it("does not report deduplicated for a fresh ID when the first attempt never appended", async () => {
    const claims = new MemoryExposureRedemptionClaimStore();
    const failOnce = new FailOnceIngestSink();
    const { app } = await makeSdkRouteHarness({
      liveRun: true,
      exposureRedemptionClaims: claims,
      exposureIngestSink: failOnce,
    });
    const ticket = await mintTicket();
    const first = (await (
      await app.request(
        PATH,
        exposuresInit(CLIENT_KEY, [{ exposureId: EXPOSURE_ID_A, exposureTicket: ticket }]),
      )
    ).json()) as ExposureBatchResponse;
    expect(first.results).toEqual([
      { exposureId: EXPOSURE_ID_A, status: "rejected", code: "SERVICE_UNAVAILABLE" },
    ]);

    // After release, a fresh ID acquires and appends when ingest recovers — never a
    // false deduplicated success for a never-appended ticket.
    const second = (await (
      await app.request(
        PATH,
        exposuresInit(CLIENT_KEY, [{ exposureId: EXPOSURE_ID_B, exposureTicket: ticket }]),
      )
    ).json()) as ExposureBatchResponse;
    expect(second.results[0]?.status).not.toBe("deduplicated");
    expect(second.results).toEqual([{ exposureId: EXPOSURE_ID_B, status: "accepted", code: null }]);
    expect(failOnce.writes).toHaveLength(1);
  });

  it("allows only one append when two concurrent requests share one exposureId", async () => {
    const claims = new MemoryExposureRedemptionClaimStore();
    const gated = new GatedIngestSink();
    const { app } = await makeSdkRouteHarness({
      liveRun: true,
      exposureRedemptionClaims: claims,
      exposureIngestSink: gated,
    });
    const ticket = await mintTicket();
    const init = exposuresInit(CLIENT_KEY, [{ exposureId: EXPOSURE_ID_A, exposureTicket: ticket }]);
    const firstPromise = app.request(PATH, init);
    await new Promise((r) => setTimeout(r, 20));
    const secondPromise = app.request(PATH, init);
    await new Promise((r) => setTimeout(r, 20));
    gated.release();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    const bodies = [
      (await first.json()) as ExposureBatchResponse,
      (await second.json()) as ExposureBatchResponse,
    ];
    const statuses = bodies.map((b) => b.results[0]?.status).sort();
    expect(statuses).toEqual(["accepted", "rejected"]);
    expect(bodies.some((b) => b.results[0]?.code === "SERVICE_UNAVAILABLE")).toBe(true);
    expect(gated.writes).toHaveLength(1);
  });

  it("rejects with SERVICE_UNAVAILABLE when the claim store throws (never fabricates acquired)", async () => {
    const claims: ExposureRedemptionClaimStore = {
      claim: async () => {
        throw new Error("claim Durable Object transport failed");
      },
      release: async () => undefined,
      markSealed: async () => undefined,
      acknowledge: async () => ({ status: "accepted" }),
    };
    const { app, exposureSink } = await makeSdkRouteHarness({
      liveRun: true,
      exposureRedemptionClaims: claims,
    });
    const ticket = await mintTicket();
    const body = (await (
      await app.request(
        PATH,
        exposuresInit(CLIENT_KEY, [{ exposureId: EXPOSURE_ID_A, exposureTicket: ticket }]),
      )
    ).json()) as ExposureBatchResponse;
    expect(body.results).toEqual([
      { exposureId: EXPOSURE_ID_A, status: "rejected", code: "SERVICE_UNAVAILABLE" },
    ]);
    expect(exposureSink.writes).toHaveLength(0);
  });
});

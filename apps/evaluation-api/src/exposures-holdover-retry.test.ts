import type { ExposureBatchResponse } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import type { HashedAssignmentPutInput } from "./assignment/assignment-store";
import { MemoryHoldoverWriteCoordinator } from "./assignment/holdover-write-outbox-memory";
import { HOLDOVER_WRITE_MAX_ATTEMPTS } from "./assignment/holdover-write-outbox-core";
import { RecordingAssignmentStore, RecordingLogger } from "./evaluate/evaluate-path-test-fixtures";
import { MemoryExposureRedemptionClaimStore } from "./exposure-redemption-claim";
import type {
  ExposureRedemptionAcknowledgeOutcome,
  ExposureRedemptionClaimInput,
  ExposureRedemptionClaimOutcome,
  ExposureRedemptionClaimStore,
} from "./exposure-redemption-claim-core";
import { ExposureRedemptionClaimTransportError } from "./exposure-redemption-claim-errors";
import { EXPOSURE_ID_A, exposuresInit, mintTicket, PATH } from "./exposures-test-fixtures";
import { APP_ID, CLIENT_KEY, EXPERIMENT_ID, makeSdkRouteHarness } from "./sdk-route-test-fixtures";

class FailOnceAssignmentStore extends RecordingAssignmentStore {
  private attempts = 0;
  readonly readable = new Map<string, { runId: string; variant: string }>();

  override async putHashed(input: HashedAssignmentPutInput) {
    this.putHashedCalls.push(input);
    this.attempts += 1;
    if (this.attempts === 1) {
      throw new Error("Assignment Store DO timeout");
    }
    this.readable.set(input.experimentId, { runId: input.runId, variant: input.variant });
    return {
      status: "stored" as const,
      assignment: { runId: input.runId, variant: input.variant },
    };
  }

  override async getAll(_input?: { appId: string; idType: string; targetingKey: string }) {
    return this.readable;
  }
}

class AlwaysFailAssignmentStore extends RecordingAssignmentStore {
  override async putHashed(input: HashedAssignmentPutInput): Promise<never> {
    this.putHashedCalls.push(input);
    throw new Error("Assignment Store permanently unavailable");
  }
}

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
      throw new ExposureRedemptionClaimTransportError(
        new Error("acknowledge Durable Object put failed"),
      );
    }
    return this.inner.acknowledge(input);
  }
}

function holdoverIdentityFromSeal(targetingKeyHash: string): HashedAssignmentPutInput {
  return {
    appId: APP_ID,
    experimentId: EXPERIMENT_ID,
    idType: "user",
    targetingKeyHash,
    runId: "run-42",
    variant: "treatment",
  };
}

describe("POST /api/sdk/exposures: durable holdover write retry (SPL-346)", () => {
  it("accepts after first put fails, owns retry, and completes without another client redemption", async () => {
    const assignmentStore = new FailOnceAssignmentStore();
    const logger = new RecordingLogger();
    const holdoverWrite = new MemoryHoldoverWriteCoordinator(assignmentStore, logger);
    const { app, exposureSink } = await makeSdkRouteHarness({
      liveRun: true,
      holdoverWrite,
    });

    const ticket = await mintTicket();
    const res = await app.request(
      PATH,
      exposuresInit(CLIENT_KEY, [{ exposureId: EXPOSURE_ID_A, exposureTicket: ticket }]),
    );
    const body = (await res.json()) as ExposureBatchResponse;
    expect(res.status).toBe(202);
    expect(body.results).toEqual([{ exposureId: EXPOSURE_ID_A, status: "accepted", code: null }]);
    expect(exposureSink.writes).toHaveLength(1);
    expect(assignmentStore.putHashedCalls).toHaveLength(1);
    expect(
      logger.errors.some((e) => e.message === "holdover_write_put_failed_owned_for_retry"),
    ).toBe(true);
    expect(assignmentStore.readable.size).toBe(0);

    const sealed = exposureSink.writes[0];
    expect(sealed).toBeDefined();
    await holdoverWrite.alarm(holdoverIdentityFromSeal(sealed?.targetingKeyHash ?? ""));
    expect(assignmentStore.putHashedCalls).toHaveLength(2);
    const holdovers = await assignmentStore.getAll({
      appId: APP_ID,
      idType: "user",
      targetingKey: "user-1",
    });
    expect(holdovers.get(EXPERIMENT_ID)).toEqual({ runId: "run-42", variant: "treatment" });
  });

  it("does not schedule holdover retry work when the Exposure seal fails", async () => {
    const assignmentStore = new FailOnceAssignmentStore();
    const holdoverWrite = new MemoryHoldoverWriteCoordinator(assignmentStore);
    const { app } = await makeSdkRouteHarness({
      liveRun: true,
      holdoverWrite,
      exposureIngestSink: {
        async write() {
          throw new Error("seal failed");
        },
      },
    });
    const ticket = await mintTicket();
    const body = (await (
      await app.request(
        PATH,
        exposuresInit(CLIENT_KEY, [{ exposureId: EXPOSURE_ID_A, exposureTicket: ticket }]),
      )
    ).json()) as ExposureBatchResponse;
    expect(body.results[0]?.status).toBe("rejected");
    expect(assignmentStore.putHashedCalls).toEqual([]);
  });

  it("rejects accepted when durable ownership cannot be sealed", async () => {
    const { app, assignmentStore } = await makeSdkRouteHarness({
      liveRun: true,
      holdoverWrite: {
        async ensure() {
          throw new Error("outbox Durable Object unavailable");
        },
      },
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
    expect(assignmentStore.putHashedCalls).toEqual([]);
  });
});

describe("POST /api/sdk/exposures: holdover exhaustion and deletion (SPL-346)", () => {
  it("resume-ack after holdover retry exhaustion fails loud with INTERNAL_SERVER_ERROR", async () => {
    const assignmentStore = new AlwaysFailAssignmentStore();
    const holdoverWrite = new MemoryHoldoverWriteCoordinator(assignmentStore);
    const claims = new FailOnceAcknowledgeStore();
    const { app, exposureSink, logger } = await makeSdkRouteHarness({
      liveRun: true,
      holdoverWrite,
      exposureRedemptionClaims: claims,
    });

    const ticket = await mintTicket();
    const init = exposuresInit(CLIENT_KEY, [{ exposureId: EXPOSURE_ID_A, exposureTicket: ticket }]);

    const first = (await (await app.request(PATH, init)).json()) as ExposureBatchResponse;
    expect(first.results).toEqual([
      { exposureId: EXPOSURE_ID_A, status: "rejected", code: "SERVICE_UNAVAILABLE" },
    ]);
    expect(exposureSink.writes).toHaveLength(1);
    expect(assignmentStore.putHashedCalls).toHaveLength(1);

    const identity = holdoverIdentityFromSeal(exposureSink.writes[0]?.targetingKeyHash ?? "");
    for (let i = 0; i < HOLDOVER_WRITE_MAX_ATTEMPTS - 1; i += 1) {
      await holdoverWrite.alarm(identity);
    }
    expect(holdoverWrite.jobFor(identity)?.status).toBe("poisoned");

    const second = (await (await app.request(PATH, init)).json()) as ExposureBatchResponse;
    expect(second.results).toEqual([
      { exposureId: EXPOSURE_ID_A, status: "rejected", code: "INTERNAL_SERVER_ERROR" },
    ]);
    expect(exposureSink.writes).toHaveLength(1);
    expect(logger.errors.some((e) => e.message === "holdover_write_retry_exhausted_at_ack")).toBe(
      true,
    );
  });

  it("App deletion suppress prevents pending alarm from recreating Assignment Store state", async () => {
    const assignmentStore = new FailOnceAssignmentStore();
    const holdoverWrite = new MemoryHoldoverWriteCoordinator(assignmentStore);
    const { app, exposureSink } = await makeSdkRouteHarness({
      liveRun: true,
      holdoverWrite,
    });
    const ticket = await mintTicket();
    await app.request(
      PATH,
      exposuresInit(CLIENT_KEY, [{ exposureId: EXPOSURE_ID_A, exposureTicket: ticket }]),
    );
    const identity = holdoverIdentityFromSeal(exposureSink.writes[0]?.targetingKeyHash ?? "");
    expect(holdoverWrite.jobFor(identity)?.status).toBe("pending");
    holdoverWrite.suppressApp(APP_ID);
    await holdoverWrite.alarm(identity);
    expect(assignmentStore.putHashedCalls).toHaveLength(1);
    // Freeze keeps accepted durable work; only puts are blocked.
    expect(holdoverWrite.jobFor(identity)?.status).toBe("pending");
    expect(assignmentStore.readable.size).toBe(0);
  });

  it("suppressed holdover is an explicit batch status, never accepted or deduplicated", async () => {
    const assignmentStore = new RecordingAssignmentStore();
    const holdoverWrite = new MemoryHoldoverWriteCoordinator(assignmentStore);
    holdoverWrite.suppressApp(APP_ID);
    const { app } = await makeSdkRouteHarness({
      liveRun: true,
      holdoverWrite,
    });
    const ticket = await mintTicket();
    const body = (await (
      await app.request(
        PATH,
        exposuresInit(CLIENT_KEY, [{ exposureId: EXPOSURE_ID_A, exposureTicket: ticket }]),
      )
    ).json()) as ExposureBatchResponse;
    expect(body.results).toEqual([{ exposureId: EXPOSURE_ID_A, status: "suppressed", code: null }]);
    expect(body.results[0]?.status).not.toBe("accepted");
    expect(body.results[0]?.status).not.toBe("deduplicated");
    expect(assignmentStore.putHashedCalls).toHaveLength(0);
  });

  it("Entity deletion suppress+purge drops poisoned hashes and blocks further puts", async () => {
    const assignmentStore = new AlwaysFailAssignmentStore();
    const holdoverWrite = new MemoryHoldoverWriteCoordinator(assignmentStore);
    const { app, exposureSink } = await makeSdkRouteHarness({
      liveRun: true,
      holdoverWrite,
    });
    const ticket = await mintTicket();
    await app.request(
      PATH,
      exposuresInit(CLIENT_KEY, [{ exposureId: EXPOSURE_ID_A, exposureTicket: ticket }]),
    );
    const identity = holdoverIdentityFromSeal(exposureSink.writes[0]?.targetingKeyHash ?? "");
    for (let i = 0; i < HOLDOVER_WRITE_MAX_ATTEMPTS - 1; i += 1) {
      await holdoverWrite.alarm(identity);
    }
    expect(holdoverWrite.jobFor(identity)?.status).toBe("poisoned");
    await holdoverWrite.suppressEntity(identity, Date.now());
    await holdoverWrite.purgeEntity(identity, Date.now());
    expect(holdoverWrite.jobFor(identity)).toBeUndefined();
    await expect(
      holdoverWrite.ensure(identity, { sourceCreatedAtMs: Date.parse("2026-07-03T00:00:00.000Z") }),
    ).resolves.toEqual({ status: "suppressed" });
    expect(assignmentStore.putHashedCalls.length).toBeGreaterThan(0);
  });

  it("Entity deletion cutoff does not treat post-delete_before_ts holdover as suppressed success", async () => {
    const assignmentStore = new RecordingAssignmentStore();
    const holdoverWrite = new MemoryHoldoverWriteCoordinator(assignmentStore);
    const cutoff = Date.parse("2026-07-03T00:00:00.000Z");
    const identity = {
      appId: APP_ID,
      experimentId: EXPERIMENT_ID,
      idType: "user",
      targetingKeyHash: "hash-post-cutoff",
      runId: "run-new",
      variant: "treatment",
    } as const;
    await holdoverWrite.deleteEntity(identity, cutoff);
    await expect(
      holdoverWrite.ensure(identity, { sourceCreatedAtMs: cutoff + 1 }),
    ).resolves.toEqual({ status: "completed" });
    expect(assignmentStore.putHashedCalls).toHaveLength(1);
  });
});

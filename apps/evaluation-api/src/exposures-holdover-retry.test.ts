import type { ExposureBatchResponse } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import type { HashedAssignmentPutInput } from "./assignment/assignment-store";
import { MemoryHoldoverWriteCoordinator } from "./assignment/holdover-write-outbox";
import { RecordingAssignmentStore, RecordingLogger } from "./evaluate/evaluate-path-test-fixtures";
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

    // No further client redemption — drive the durable retry alarm.
    const sealed = exposureSink.writes[0];
    expect(sealed).toBeDefined();
    await holdoverWrite.alarm({
      appId: APP_ID,
      experimentId: EXPERIMENT_ID,
      idType: "user",
      targetingKeyHash: sealed?.targetingKeyHash ?? "",
      runId: "run-42",
      variant: "treatment",
    });
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

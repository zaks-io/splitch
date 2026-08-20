import { describe, expect, it } from "vitest";
import type { HashedAssignmentPutInput } from "./assignment-store";
import {
  deleteEntityOutbox,
  type HoldoverWriteJob,
  type HoldoverWriteOutboxStorage,
  holdoverWriteJobKey,
  holdoverWriteRetryDelayMs,
} from "./holdover-write-outbox-core";
import { runHoldoverWriteAlarm } from "./holdover-write-outbox-ensure";

const BASE_PUT: HashedAssignmentPutInput = {
  appId: "app-A",
  experimentId: "exp-1",
  idType: "user",
  targetingKeyHash: "hash-abc",
  runId: "run-42",
  variant: "treatment",
};

class MemoryStorage implements HoldoverWriteOutboxStorage {
  readonly values = new Map<string, unknown>();
  alarm: number | undefined;

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }
  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }
  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }
  async list<T>(options?: { prefix?: string }): Promise<Map<string, T>> {
    return new Map(
      [...this.values.entries()]
        .filter(([key]) => options?.prefix === undefined || key.startsWith(options.prefix))
        .map(([key, value]) => [key, value as T]),
    );
  }
  async setAlarm(scheduledTime: number): Promise<void> {
    this.alarm = scheduledTime;
  }
  async deleteAlarm(): Promise<void> {
    this.alarm = undefined;
  }
}

describe("holdover write outbox scheduling", () => {
  it("retries only pending jobs whose individual backoff is due", async () => {
    const storage = new MemoryStorage();
    const older = job({ experimentId: "exp-older", attempt: 6, updatedAtMs: 1_000 });
    const newer = job({ experimentId: "exp-newer", attempt: 1, updatedAtMs: 31_000 });
    await storage.put(holdoverWriteJobKey(older.experimentId), older);
    await storage.put(holdoverWriteJobKey(newer.experimentId), newer);
    const calls: string[] = [];
    const put = {
      async putHashed(input: HashedAssignmentPutInput) {
        calls.push(input.experimentId);
        throw new Error("forced put failure");
      },
    };

    await runHoldoverWriteAlarm(storage, put, 32_000);

    expect(calls).toEqual([newer.experimentId]);
    expect(await storage.get<HoldoverWriteJob>(holdoverWriteJobKey(older.experimentId))).toEqual(
      older,
    );
    expect(storage.alarm).toBe(33_000);

    await runHoldoverWriteAlarm(storage, put, 33_000);

    expect(calls).toEqual([newer.experimentId, older.experimentId]);
    expect(
      await storage.get<HoldoverWriteJob>(holdoverWriteJobKey(older.experimentId)),
    ).toMatchObject({ status: "pending", attempt: 7, updatedAtMs: 33_000 });
  });

  it("reschedules a retained post-cutoff pending job", async () => {
    const storage = new MemoryStorage();
    const retained = job({ experimentId: "exp-retained", attempt: 3, updatedAtMs: 2_500 });
    await storage.put(holdoverWriteJobKey(retained.experimentId), retained);

    await deleteEntityOutbox(storage, 1_500);

    expect(await storage.get(holdoverWriteJobKey(retained.experimentId))).toEqual(retained);
    expect(storage.alarm).toBe(2_500 + holdoverWriteRetryDelayMs(3));
  });
});

function job(input: {
  experimentId: string;
  attempt: number;
  updatedAtMs: number;
}): HoldoverWriteJob {
  return {
    ...BASE_PUT,
    experimentId: input.experimentId,
    status: "pending",
    attempt: input.attempt,
    createdAtMs: input.updatedAtMs - 500,
    updatedAtMs: input.updatedAtMs,
  };
}

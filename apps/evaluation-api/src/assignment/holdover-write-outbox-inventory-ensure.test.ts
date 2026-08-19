import { describe, expect, it } from "vitest";
import type { HashedAssignmentPutInput } from "./assignment-store";
import {
  type HoldoverWriteJob,
  type HoldoverWriteOutboxStorage,
  holdoverWriteJobKey,
} from "./holdover-write-outbox-core";
import { ensureHoldoverWriteJob } from "./holdover-write-outbox-ensure";

const basePut: HashedAssignmentPutInput = {
  appId: "app-A",
  experimentId: "exp-1",
  idType: "user",
  targetingKeyHash: "hash-abc",
  runId: "run-42",
  variant: "treatment",
};

class OkPut {
  readonly calls: HashedAssignmentPutInput[] = [];
  async putHashed(input: HashedAssignmentPutInput): Promise<{ status: "stored" }> {
    this.calls.push(input);
    return { status: "stored" };
  }
}

class MemoryStorage implements HoldoverWriteOutboxStorage {
  readonly values = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }
  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }
  async delete(key: string): Promise<boolean | undefined> {
    const had = this.values.has(key);
    this.values.delete(key);
    return had;
  }
  async list<T>(options?: { prefix?: string }): Promise<Map<string, T>> {
    const out = new Map<string, T>();
    for (const [key, value] of this.values) {
      if (options?.prefix === undefined || key.startsWith(options.prefix)) {
        out.set(key, value as T);
      }
    }
    return out;
  }
  async setAlarm(_scheduledTime: number): Promise<void> {}
  async deleteAlarm(): Promise<void> {}
  get job(): HoldoverWriteJob | undefined {
    return this.values.get(holdoverWriteJobKey(basePut.experimentId)) as
      | HoldoverWriteJob
      | undefined;
  }
}

describe("holdover write App inventory registration on ensure", () => {
  it("registers on every ensure and repairs after a prior transport failure", async () => {
    const put = new OkPut();
    const storage = new MemoryStorage();
    const registrations: Array<{ idType: string; targetingKeyHash: string }> = [];
    let failuresRemaining = 1;
    const inventory = {
      async registerEntity(ref: { idType: string; targetingKeyHash: string }) {
        if (failuresRemaining > 0) {
          failuresRemaining -= 1;
          throw new Error("forced inventory transport failure");
        }
        registrations.push(ref);
        return { status: "registered" as const };
      },
    };

    await expect(
      ensureHoldoverWriteJob(
        storage,
        put,
        basePut,
        1_000,
        undefined,
        undefined,
        undefined,
        inventory,
      ),
    ).rejects.toThrow(/forced inventory transport failure/);
    expect(storage.job).toBeUndefined();
    expect(registrations).toEqual([]);

    await expect(
      ensureHoldoverWriteJob(
        storage,
        put,
        basePut,
        2_000,
        undefined,
        undefined,
        undefined,
        inventory,
      ),
    ).resolves.toEqual({ status: "completed" });
    expect(registrations).toEqual([
      { idType: basePut.idType, targetingKeyHash: basePut.targetingKeyHash },
    ]);

    // Existing job path still re-registers (repair / confirm).
    await expect(
      ensureHoldoverWriteJob(
        storage,
        put,
        basePut,
        3_000,
        undefined,
        undefined,
        undefined,
        inventory,
      ),
    ).resolves.toEqual({ status: "completed" });
    expect(registrations).toHaveLength(2);
  });

  it("returns suppressed when App inventory refuses registration after deletion began", async () => {
    const put = new OkPut();
    const storage = new MemoryStorage();
    await ensureHoldoverWriteJob(storage, put, basePut, 1_000);
    expect(storage.job).toBeUndefined();
    // Seed a pending job as if a prior ensure owned retry, then inventory deletes.
    await storage.put(holdoverWriteJobKey(basePut.experimentId), {
      ...basePut,
      status: "pending",
      attempt: 1,
      createdAtMs: 1_000,
      updatedAtMs: 1_000,
    } satisfies HoldoverWriteJob);

    await expect(
      ensureHoldoverWriteJob(storage, put, basePut, 2_000, undefined, undefined, undefined, {
        async registerEntity() {
          return { status: "suppressed" };
        },
      }),
    ).resolves.toEqual({ status: "suppressed" });
    expect(storage.job).toBeUndefined();
  });
});

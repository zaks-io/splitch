import { describe, expect, it } from "vitest";
import { RecordingKv } from "./assignment-store-test-fixtures";
import {
  advanceAppDeletionCancelSaga,
  advanceAppDeletionFinalizeSaga,
  beginOrResumeAppDeletionCancelSaga,
  markAppDeletionSagaD1Deleted,
  prepareAppDeletionSaga,
  readAppDeletionSaga,
} from "./holdover-write-app-deletion-saga";
import {
  type HoldoverWriteAppInventoryStorage,
  appInventoryStatus,
  registerAppInventoryEntity,
} from "./holdover-write-app-inventory";
import { appHoldoverWriteSuppressKey } from "./holdover-write-outbox-core";

class MemoryInventoryStorage implements HoldoverWriteAppInventoryStorage {
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
}

describe("holdover write App deletion saga boundaries", () => {
  it("prepare leaves DO suppressed when KV put fails, then durable cancel restores", async () => {
    const storage = new MemoryInventoryStorage();
    await registerAppInventoryEntity(storage, { idType: "user", targetingKeyHash: "hash-1" });
    const kv = new RecordingKv({ failPutsRemaining: 1 });

    // Resume unavailable in the failing prepare request → cancel stays incomplete.
    await expect(prepareAppDeletionSaga(storage, kv, "app-A", 5_000, null)).rejects.toThrow(
      /KV freeze failed and cancel is incomplete|forced KV put failure/,
    );

    expect(await storage.get<boolean>("suppressed")).toBe(true);
    expect(kv.has(appHoldoverWriteSuppressKey("app-A"))).toBe(false);
    expect(await readAppDeletionSaga(storage)).toMatchObject({ phase: "canceling" });

    const resumes: string[] = [];
    await expect(
      advanceAppDeletionCancelSaga(storage, kv, "app-A", {
        async resumeAlarms(identity: { targetingKeyHash: string }) {
          resumes.push(identity.targetingKeyHash);
        },
      }),
    ).resolves.toEqual({ done: true });
    expect(await storage.get<boolean>("suppressed")).toBeUndefined();
    expect(await readAppDeletionSaga(storage)).toBeNull();
    expect(resumes).toEqual(["hash-1"]);
    expect(
      await registerAppInventoryEntity(storage, { idType: "user", targetingKeyHash: "hash-2" }),
    ).toEqual({ status: "registered" });
  });

  it("cancel checkpoints mid-list resume and KV delete failures then recovers without a request", async () => {
    const storage = new MemoryInventoryStorage();
    await registerAppInventoryEntity(storage, { idType: "user", targetingKeyHash: "hash-1" });
    await registerAppInventoryEntity(storage, { idType: "user", targetingKeyHash: "hash-2" });
    const kv = new RecordingKv();
    await prepareAppDeletionSaga(storage, kv, "app-A", 9_000, {
      async resumeAlarms() {
        return undefined;
      },
    });
    expect(kv.has(appHoldoverWriteSuppressKey("app-A"))).toBe(true);

    let resumeFailsRemaining = 1;
    const resumed: string[] = [];
    const resume = {
      async resumeAlarms(identity: { targetingKeyHash: string }) {
        if (resumeFailsRemaining > 0) {
          resumeFailsRemaining -= 1;
          throw new Error("forced resume-alarms failure");
        }
        resumed.push(identity.targetingKeyHash);
      },
    };

    kv.failDeletesRemaining = 1;
    await expect(beginOrResumeAppDeletionCancelSaga(storage, kv, "app-A", resume)).rejects.toThrow(
      /forced KV delete failure/,
    );
    expect(resumed).toEqual([]);
    expect(await readAppDeletionSaga(storage)).toMatchObject({
      phase: "canceling",
      cancelKvCleared: false,
    });

    await expect(advanceAppDeletionCancelSaga(storage, kv, "app-A", resume)).resolves.toEqual({
      done: false,
    });
    expect(await readAppDeletionSaga(storage)).toMatchObject({
      phase: "canceling",
      cancelResumePending: [{ idType: "user", targetingKeyHash: "hash-1" }],
    });
    expect(resumed).toEqual(["hash-2"]);

    expect(kv.has(appHoldoverWriteSuppressKey("app-A"))).toBe(false);
    expect(await storage.get<boolean>("suppressed")).toBe(true);

    await expect(advanceAppDeletionCancelSaga(storage, kv, "app-A", resume)).resolves.toEqual({
      done: true,
    });
    expect(resumed).toEqual(["hash-2", "hash-1"]);
    expect(kv.has(appHoldoverWriteSuppressKey("app-A"))).toBe(false);
    expect(await storage.get<boolean>("suppressed")).toBeUndefined();
    expect(await readAppDeletionSaga(storage)).toBeNull();
  });

  it("finalize after D1 boundary refuses cancel and resumes after Entity purge failure", async () => {
    const storage = new MemoryInventoryStorage();
    await registerAppInventoryEntity(storage, { idType: "user", targetingKeyHash: "hash-1" });
    const kv = new RecordingKv();
    await prepareAppDeletionSaga(storage, kv, "app-A", 7_000, {
      async resumeAlarms() {
        return undefined;
      },
    });
    await markAppDeletionSagaD1Deleted(storage, "app-A");
    expect(await readAppDeletionSaga(storage)).toMatchObject({ phase: "d1_deleted" });

    await expect(
      beginOrResumeAppDeletionCancelSaga(storage, kv, "app-A", {
        async resumeAlarms() {
          return undefined;
        },
      }),
    ).resolves.toEqual({ done: true, cancelled: false });

    let purgeFails = 1;
    const purge = {
      async purgeEntity() {
        if (purgeFails > 0) {
          purgeFails -= 1;
          throw new Error("forced entity purge failure");
        }
      },
    };
    await expect(advanceAppDeletionFinalizeSaga(storage, "app-A", purge)).rejects.toThrow(
      /forced entity purge failure/,
    );
    expect(await readAppDeletionSaga(storage)).toMatchObject({ phase: "finalizing" });

    await expect(advanceAppDeletionFinalizeSaga(storage, "app-A", purge)).resolves.toEqual({
      done: true,
    });
    expect(await appInventoryStatus(storage)).toMatchObject({
      deletionComplete: true,
      sagaPhase: "completed",
      entities: [],
    });
  });
});

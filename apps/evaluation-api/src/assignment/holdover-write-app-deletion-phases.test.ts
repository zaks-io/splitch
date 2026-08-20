import { describe, expect, it } from "vitest";
import { MemoryHoldoverWriteAppInventoryClient } from "../sdk-route-binding-cleanup-fixture";
import {
  cancelAppHoldoverWriteDeletion,
  finalizeAppHoldoverWriteDeletion,
  prepareAppHoldoverWriteDeletion,
} from "./holdover-write-deletion";
import {
  type HoldoverWriteOutboxStorage,
  type HoldoverWritePutPort,
  holdoverWriteJobKey,
} from "./holdover-write-outbox-core";
import { ensureHoldoverWriteJob, runHoldoverWriteAlarm } from "./holdover-write-outbox-ensure";

const PUT = {
  appId: "app-A",
  experimentId: "exp-1",
  idType: "user",
  targetingKeyHash: "hash-entity",
  runId: "run-1",
  variant: "treatment",
} as const;

class MemoryOutboxStorage implements HoldoverWriteOutboxStorage {
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
  async setAlarm(): Promise<void> {}
  async deleteAlarm(): Promise<void> {}
}

describe("holdover write App deletion two-phase boundary", () => {
  it("prepare freezes without purge; cancel restores; finalize drains", async () => {
    const resumes: string[] = [];
    const inventory = new MemoryHoldoverWriteAppInventoryClient({
      resume: {
        async resumeAlarms(identity) {
          resumes.push(identity.targetingKeyHash);
        },
      },
    });
    await inventory.registerEntity("app-A", {
      idType: PUT.idType,
      targetingKeyHash: PUT.targetingKeyHash,
    });
    const storage = new MemoryOutboxStorage();
    const putCalls: unknown[] = [];
    const put: HoldoverWritePutPort = {
      async putHashed(input) {
        putCalls.push(input);
        throw new Error("forced put failure");
      },
    };
    await ensureHoldoverWriteJob(storage, put, PUT, 1_000, undefined, undefined, {
      sourceCreatedAtMs: 1_000,
    });
    expect(storage.values.has(holdoverWriteJobKey(PUT.experimentId))).toBe(true);

    await prepareAppHoldoverWriteDeletion(inventory, "app-A", 5_000);
    expect(await inventory.status("app-A")).toMatchObject({
      suppressed: true,
      deletionComplete: false,
      sagaPhase: "prepared",
      entities: [{ idType: PUT.idType, targetingKeyHash: PUT.targetingKeyHash }],
    });
    const putsBefore = putCalls.length;
    await runHoldoverWriteAlarm(storage, put, 2_000, undefined, {
      async isAppSuppressed(appId) {
        return inventory.isSuppressed(appId);
      },
    });
    expect(putCalls).toHaveLength(putsBefore);
    expect(storage.values.has(holdoverWriteJobKey(PUT.experimentId))).toBe(true);

    const wakeOutbox = {
      idFromName(name: string) {
        return name as unknown as DurableObjectId;
      },
      get() {
        return {
          async fetch() {
            return Response.json({ ok: true });
          },
        };
      },
    };
    await cancelAppHoldoverWriteDeletion(inventory, wakeOutbox, "app-A");
    expect(resumes).toEqual([PUT.targetingKeyHash]);
    expect(await inventory.status("app-A")).toMatchObject({
      suppressed: false,
      deletionComplete: false,
      sagaPhase: null,
      entities: [{ idType: PUT.idType, targetingKeyHash: PUT.targetingKeyHash }],
    });

    await prepareAppHoldoverWriteDeletion(inventory, "app-A", 5_000);
    const deleted: string[] = [];
    const finalizeOutbox = {
      idFromName(name: string) {
        return name as unknown as DurableObjectId;
      },
      get(id: DurableObjectId) {
        return {
          async fetch() {
            deleted.push(String(id));
            await inventory.markEntityPurged("app-A", {
              idType: PUT.idType,
              targetingKeyHash: PUT.targetingKeyHash,
            });
            return Response.json({ ok: true });
          },
        };
      },
    };
    await finalizeAppHoldoverWriteDeletion(inventory, finalizeOutbox, "app-A", 5_000);
    expect(deleted).toEqual([`${PUT.appId}:${PUT.idType}:${PUT.targetingKeyHash}`]);
    expect(await inventory.status("app-A")).toMatchObject({
      suppressed: true,
      deletionComplete: true,
      sagaPhase: "completed",
      entities: [],
    });
  });

  it("finalize resumes after a mid-purge failure", async () => {
    const inventory = new MemoryHoldoverWriteAppInventoryClient();
    await inventory.registerEntity("app-A", { idType: "user", targetingKeyHash: "hash-1" });
    await inventory.registerEntity("app-A", { idType: "user", targetingKeyHash: "hash-2" });
    await prepareAppHoldoverWriteDeletion(inventory, "app-A", 5_000);
    let calls = 0;
    const outbox = {
      idFromName(name: string) {
        return name as unknown as DurableObjectId;
      },
      get() {
        return {
          async fetch() {
            calls += 1;
            if (calls === 1) throw new Error("forced purge failure");
            return Response.json({ ok: true });
          },
        };
      },
    };
    await expect(
      finalizeAppHoldoverWriteDeletion(inventory, outbox, "app-A", 5_000),
    ).rejects.toThrow(/forced purge failure/);
    expect((await inventory.status("app-A")).deletionComplete).toBe(false);
    expect((await inventory.status("app-A")).suppressed).toBe(true);
    expect((await inventory.status("app-A")).sagaPhase).toBe("d1_deleted");
    await finalizeAppHoldoverWriteDeletion(inventory, outbox, "app-A", 5_000);
    expect(await inventory.status("app-A")).toMatchObject({
      deletionComplete: true,
      sagaPhase: "completed",
      entities: [],
    });
  });
});

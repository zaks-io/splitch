import { describe, expect, it } from "vitest";
import {
  beginAppInventoryDeletion,
  completeAppInventoryDeletion,
  type HoldoverWriteAppInventoryStorage,
  markAppInventoryEntityPurged,
  registerAppInventoryEntity,
} from "./holdover-write-app-inventory";
import {
  deleteEntityOutbox,
  HOLDOVER_WRITE_ENTITY_SUPPRESSED_KEY,
  HOLDOVER_WRITE_MAX_ATTEMPTS,
  type HoldoverWriteJob,
  type HoldoverWriteOutboxStorage,
  type HoldoverWritePutPort,
  holdoverWriteJobDueAtMs,
  holdoverWriteJobKey,
} from "./holdover-write-outbox-core";
import { ensureHoldoverWriteJob } from "./holdover-write-outbox-ensure";

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
  alarm: number | undefined;
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
  async setAlarm(scheduledTime: number): Promise<void> {
    this.alarm = scheduledTime;
  }
  async deleteAlarm(): Promise<void> {
    this.alarm = undefined;
  }
}

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

/** Serializes critical sections the way DO `blockConcurrencyWhile` does. */
class ConcurrencyGate {
  private chain: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

describe("holdover write deletion production-boundary contracts", () => {
  it("App inventory registers poisoned Entity outboxes without Assignment KV", async () => {
    const inventory = new MemoryInventoryStorage();
    await registerAppInventoryEntity(inventory, {
      idType: PUT.idType,
      targetingKeyHash: PUT.targetingKeyHash,
    });
    const begun = await beginAppInventoryDeletion(inventory, 9_000);
    expect(begun.suppressed).toBe(true);
    expect(begun.entities).toEqual([
      { idType: PUT.idType, targetingKeyHash: PUT.targetingKeyHash },
    ]);
    const registered = begun.entities[0];
    expect(registered).toBeDefined();
    if (registered === undefined) throw new Error("expected registered entity");
    await markAppInventoryEntityPurged(inventory, registered);
    await completeAppInventoryDeletion(inventory);
    const again = await beginAppInventoryDeletion(inventory, 9_000);
    expect(again.deletionComplete).toBe(true);
    expect(again.entities).toEqual([]);
  });
});

describe("holdover write Entity deletion boundary", () => {
  it("Entity cutoff suppresses stale jobs and permits post-cutoff ensure", async () => {
    const storage = new MemoryOutboxStorage();
    const put: HoldoverWritePutPort = {
      async putHashed() {
        return undefined;
      },
    };
    await ensureHoldoverWriteJob(storage, put, PUT, 1_000, undefined, undefined, {
      sourceCreatedAtMs: 1_000,
    });
    await deleteEntityOutbox(storage, 1_500);
    expect(await storage.get(HOLDOVER_WRITE_ENTITY_SUPPRESSED_KEY)).toEqual({
      deleteBeforeTsMs: 1_500,
    });
    expect(storage.values.has(holdoverWriteJobKey(PUT.experimentId))).toBe(false);
    await expect(
      ensureHoldoverWriteJob(storage, put, PUT, 2_000, undefined, undefined, {
        sourceCreatedAtMs: 1_400,
      }),
    ).resolves.toEqual({ status: "suppressed" });
    await expect(
      ensureHoldoverWriteJob(storage, put, PUT, 2_000, undefined, undefined, {
        sourceCreatedAtMs: 1_600,
      }),
    ).resolves.toEqual({ status: "completed" });
  });

  it("Entity delete purges poisoned job rows under the cutoff", async () => {
    const storage = new MemoryOutboxStorage();
    const put: HoldoverWritePutPort = {
      async putHashed() {
        throw new Error("always fail");
      },
    };
    let now = 1_000;
    await ensureHoldoverWriteJob(storage, put, PUT, now, undefined, undefined, {
      sourceCreatedAtMs: 1_000,
    });
    for (let i = 0; i < HOLDOVER_WRITE_MAX_ATTEMPTS - 1; i += 1) {
      const pending = await storage.get<HoldoverWriteJob>(holdoverWriteJobKey(PUT.experimentId));
      if (pending === undefined) throw new Error("expected pending holdover write job");
      now = holdoverWriteJobDueAtMs(pending);
      await ensureHoldoverWriteJob(storage, put, PUT, now);
    }
    const poisoned = (await storage.get(holdoverWriteJobKey(PUT.experimentId))) as
      | HoldoverWriteJob
      | undefined;
    expect(poisoned?.status).toBe("poisoned");
    await deleteEntityOutbox(storage, now);
    expect(storage.values.has(holdoverWriteJobKey(PUT.experimentId))).toBe(false);
  });

  it("Entity delete serializes behind an in-flight Assignment Store writer call", async () => {
    const storage = new MemoryOutboxStorage();
    const gate = new ConcurrencyGate();
    let putStarted = false;
    let putFinished = false;
    let deleteSawPutFinished = false;
    let releasePut!: () => void;
    const putBlocked = new Promise<void>((resolve) => {
      releasePut = resolve;
    });
    const put: HoldoverWritePutPort = {
      async putHashed() {
        putStarted = true;
        await putBlocked;
        putFinished = true;
      },
    };
    const ensurePromise = gate.run(() =>
      ensureHoldoverWriteJob(storage, put, PUT, 1_000, undefined, undefined, {
        sourceCreatedAtMs: 1_000,
      }),
    );
    await viWaitFor(() => putStarted);
    const deletePromise = gate.run(async () => {
      deleteSawPutFinished = putFinished;
      await deleteEntityOutbox(storage, 2_000);
    });
    expect(putFinished).toBe(false);
    releasePut();
    await expect(ensurePromise).resolves.toEqual({ status: "completed" });
    await deletePromise;
    expect(deleteSawPutFinished).toBe(true);
    expect(await storage.get(HOLDOVER_WRITE_ENTITY_SUPPRESSED_KEY)).toEqual({
      deleteBeforeTsMs: 2_000,
    });
  });
});

async function viWaitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

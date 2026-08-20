import type { AssignmentKv } from "./assignment/assignment-store";
import type {
  HoldoverWriteAppDeletionBeginResult,
  HoldoverWriteAppEntityRef,
  HoldoverWriteAppInventoryRegisterResult,
  HoldoverWriteAppInventoryStatus,
} from "./assignment/holdover-write-app-inventory";
import type {
  HoldoverWriteAppInventoryCancelResult,
  HoldoverWriteAppInventoryClient,
} from "./assignment/holdover-write-app-inventory-client";
import type { HoldoverWriteOutboxCleanupDeps } from "./assignment/holdover-write-outbox-cleanup";
import {
  advanceAppDeletionCancelSaga,
  beginOrResumeAppDeletionCancelSaga,
  markAppDeletionSagaD1Deleted,
  prepareAppDeletionSaga,
  readAppDeletionSaga,
  type HoldoverWriteEntityAlarmResumePort,
} from "./assignment/holdover-write-app-deletion-saga";
import {
  completeAppInventoryDeletion,
  markAppInventoryEntityPurged,
  registerAppInventoryEntity,
  type HoldoverWriteAppInventoryStorage,
  appInventoryStatus,
} from "./assignment/holdover-write-app-inventory";

/** In-memory App inventory backed by the durable deletion saga helpers. */
export class MemoryHoldoverWriteAppInventoryClient implements HoldoverWriteAppInventoryClient {
  readonly storage = new MemoryInventoryStorage();
  kv: AssignmentKv;
  resumePort: HoldoverWriteEntityAlarmResumePort | null = null;

  constructor(options: { kv?: AssignmentKv; resume?: HoldoverWriteEntityAlarmResumePort } = {}) {
    this.kv = options.kv ?? new MemoryAssignmentKv();
    this.resumePort =
      options.resume ??
      ({
        async resumeAlarms() {
          return undefined;
        },
      } satisfies HoldoverWriteEntityAlarmResumePort);
  }

  async registerEntity(
    appId: string,
    ref: HoldoverWriteAppEntityRef,
  ): Promise<HoldoverWriteAppInventoryRegisterResult> {
    void appId;
    return registerAppInventoryEntity(this.storage, ref);
  }

  async beginDeletion(
    appId: string,
    deleteBeforeTsMs: number,
  ): Promise<HoldoverWriteAppDeletionBeginResult> {
    const result = await prepareAppDeletionSaga(
      this.storage,
      this.kv,
      appId,
      deleteBeforeTsMs,
      this.resumePort,
    );
    const status = await appInventoryStatus(this.storage);
    return {
      suppressed: true,
      deletionComplete: result.deletionComplete,
      deleteBeforeTsMs,
      entities: status.entities,
    };
  }

  async cancelDeletion(appId: string): Promise<HoldoverWriteAppInventoryCancelResult> {
    const result = await beginOrResumeAppDeletionCancelSaga(
      this.storage,
      this.kv,
      appId,
      this.resumePort,
    );
    const saga = await readAppDeletionSaga(this.storage);
    return {
      cancelled: result.cancelled,
      done: result.done,
      entities: saga?.cancelResumePending ?? [],
      sagaPhase: saga?.phase ?? null,
    };
  }

  async advanceCancel(appId: string): Promise<{ readonly done: boolean }> {
    return advanceAppDeletionCancelSaga(this.storage, this.kv, appId, this.resumePort);
  }

  async markD1Deleted(appId: string, deleteBeforeTsMs?: number): Promise<void> {
    await markAppDeletionSagaD1Deleted(this.storage, appId, deleteBeforeTsMs);
  }

  async markEntityPurged(appId: string, ref: HoldoverWriteAppEntityRef): Promise<void> {
    void appId;
    await markAppInventoryEntityPurged(this.storage, ref);
  }

  async completeDeletion(appId: string): Promise<void> {
    void appId;
    await completeAppInventoryDeletion(this.storage);
  }

  async status(appId: string): Promise<HoldoverWriteAppInventoryStatus> {
    void appId;
    return appInventoryStatus(this.storage);
  }

  async isSuppressed(appId: string): Promise<boolean> {
    return (await this.status(appId)).suppressed;
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

class MemoryAssignmentKv implements AssignmentKv {
  private readonly store = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

/** Binding-door harness stub so route-surface mounting can register cleanup. */
export function stubHoldoverWriteOutboxCleanup(): HoldoverWriteOutboxCleanupDeps {
  return {
    assignmentsKv: {
      async get() {
        return null;
      },
      async put() {
        return undefined;
      },
      async delete() {
        return undefined;
      },
    },
    holdoverWriteOutbox: {
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
    },
    holdoverWriteAppInventory: new MemoryHoldoverWriteAppInventoryClient(),
  };
}

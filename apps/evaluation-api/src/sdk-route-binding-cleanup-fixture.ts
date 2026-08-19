import type {
  HoldoverWriteAppDeletionBeginResult,
  HoldoverWriteAppEntityRef,
  HoldoverWriteAppInventoryRegisterResult,
  HoldoverWriteAppInventoryStatus,
} from "./assignment/holdover-write-app-inventory";
import type { HoldoverWriteAppInventoryClient } from "./assignment/holdover-write-app-inventory-client";
import type { HoldoverWriteOutboxCleanupDeps } from "./assignment/holdover-write-outbox-cleanup";

/** In-memory App inventory for unit / route harnesses. */
export class MemoryHoldoverWriteAppInventoryClient implements HoldoverWriteAppInventoryClient {
  private readonly apps = new Map<
    string,
    {
      suppressed: boolean;
      deletionComplete: boolean;
      deleteBeforeTsMs: number | null;
      entities: Map<string, HoldoverWriteAppEntityRef>;
    }
  >();

  async registerEntity(
    appId: string,
    ref: HoldoverWriteAppEntityRef,
  ): Promise<HoldoverWriteAppInventoryRegisterResult> {
    const state = this.state(appId);
    if (state.suppressed || state.deletionComplete) {
      return { status: "suppressed" };
    }
    state.entities.set(`${ref.idType}:${ref.targetingKeyHash}`, ref);
    return { status: "registered" };
  }

  async beginDeletion(
    appId: string,
    deleteBeforeTsMs: number,
  ): Promise<HoldoverWriteAppDeletionBeginResult> {
    const state = this.state(appId);
    state.suppressed = true;
    state.deleteBeforeTsMs = deleteBeforeTsMs;
    if (state.deletionComplete) {
      return {
        suppressed: true,
        deletionComplete: true,
        entities: [],
        deleteBeforeTsMs,
      };
    }
    return {
      suppressed: true,
      deletionComplete: false,
      entities: [...state.entities.values()],
      deleteBeforeTsMs,
    };
  }

  async markEntityPurged(appId: string, ref: HoldoverWriteAppEntityRef): Promise<void> {
    this.state(appId).entities.delete(`${ref.idType}:${ref.targetingKeyHash}`);
  }

  async completeDeletion(appId: string): Promise<void> {
    const state = this.state(appId);
    if (state.entities.size > 0) {
      throw new Error(`completeDeletion: ${String(state.entities.size)} entities remain`);
    }
    state.suppressed = true;
    state.deletionComplete = true;
  }

  async status(appId: string): Promise<HoldoverWriteAppInventoryStatus> {
    const state = this.state(appId);
    return {
      suppressed: state.suppressed,
      deletionComplete: state.deletionComplete,
      deleteBeforeTsMs: state.deleteBeforeTsMs,
      entities: [...state.entities.values()],
    };
  }

  async isSuppressed(appId: string): Promise<boolean> {
    return this.state(appId).suppressed;
  }

  private state(appId: string) {
    let current = this.apps.get(appId);
    if (current === undefined) {
      current = {
        suppressed: false,
        deletionComplete: false,
        deleteBeforeTsMs: null,
        entities: new Map(),
      };
      this.apps.set(appId, current);
    }
    return current;
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

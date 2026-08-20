import {
  type HoldoverWriteAppDeletionBeginResult,
  type HoldoverWriteAppEntityRef,
  type HoldoverWriteAppInventoryNamespace,
  type HoldoverWriteAppInventoryRegisterResult,
  type HoldoverWriteAppInventoryStatus,
  holdoverWriteAppInventoryName,
} from "./holdover-write-app-inventory";
import type { HoldoverWriteAppDeletionSagaPhase } from "./holdover-write-app-deletion-saga";
import type { HoldoverWriteInventoryRegisterPort } from "./holdover-write-outbox-ensure";

class HoldoverWriteAppInventoryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HoldoverWriteAppInventoryError";
  }
}

export interface HoldoverWriteAppInventoryCancelResult {
  readonly cancelled: boolean;
  readonly done: boolean;
  readonly entities: readonly HoldoverWriteAppEntityRef[];
  readonly sagaPhase: HoldoverWriteAppDeletionSagaPhase | null;
}

export interface HoldoverWriteAppInventoryClient {
  registerEntity(
    appId: string,
    ref: HoldoverWriteAppEntityRef,
  ): Promise<HoldoverWriteAppInventoryRegisterResult>;
  beginDeletion(
    appId: string,
    generationId: string,
    deleteBeforeTsMs: number,
  ): Promise<HoldoverWriteAppDeletionBeginResult>;
  cancelDeletion(
    appId: string,
    generationId: string,
  ): Promise<HoldoverWriteAppInventoryCancelResult>;
  markD1Deleted(appId: string, generationId: string, deleteBeforeTsMs?: number): Promise<void>;
  finalizeDeletion(appId: string, generationId: string, deleteBeforeTsMs?: number): Promise<void>;
  markEntityPurged(appId: string, ref: HoldoverWriteAppEntityRef): Promise<void>;
  status(appId: string): Promise<HoldoverWriteAppInventoryStatus>;
  isSuppressed(appId: string): Promise<boolean>;
}

export class DurableHoldoverWriteAppInventoryClient implements HoldoverWriteAppInventoryClient {
  constructor(private readonly namespace: HoldoverWriteAppInventoryNamespace) {}

  async registerEntity(
    appId: string,
    ref: HoldoverWriteAppEntityRef,
  ): Promise<HoldoverWriteAppInventoryRegisterResult> {
    const body = await this.postJson(appId, "/register", ref);
    if (!isRecord(body) || (body.status !== "registered" && body.status !== "suppressed")) {
      throw new HoldoverWriteAppInventoryError("register returned an invalid payload");
    }
    return { status: body.status };
  }

  async beginDeletion(
    appId: string,
    generationId: string,
    deleteBeforeTsMs: number,
  ): Promise<HoldoverWriteAppDeletionBeginResult> {
    const body = await this.postJson(appId, "/begin-deletion", {
      appId,
      generationId,
      deleteBeforeTsMs,
    });
    if (
      !isRecord(body) ||
      body.suppressed !== true ||
      typeof body.deletionComplete !== "boolean" ||
      typeof body.deleteBeforeTsMs !== "number" ||
      body.generationId !== generationId ||
      !Array.isArray(body.entities)
    ) {
      throw new HoldoverWriteAppInventoryError("begin-deletion returned an invalid payload");
    }
    return {
      generationId,
      suppressed: true,
      deletionComplete: body.deletionComplete,
      deleteBeforeTsMs: body.deleteBeforeTsMs,
      entities: body.entities.map(parseEntityRef),
    };
  }

  async cancelDeletion(
    appId: string,
    generationId: string,
  ): Promise<HoldoverWriteAppInventoryCancelResult> {
    const body = await this.postJson(appId, "/cancel-deletion", { appId, generationId });
    if (!isRecord(body) || typeof body.cancelled !== "boolean" || !Array.isArray(body.entities)) {
      throw new HoldoverWriteAppInventoryError("cancel-deletion returned an invalid payload");
    }
    return {
      cancelled: body.cancelled,
      done: body.done === true,
      entities: body.entities.map(parseEntityRef),
      sagaPhase: parseSagaPhase(body.sagaPhase),
    };
  }

  async markD1Deleted(
    appId: string,
    generationId: string,
    deleteBeforeTsMs?: number,
  ): Promise<void> {
    await this.post(appId, "/mark-d1-deleted", {
      appId,
      generationId,
      ...(deleteBeforeTsMs !== undefined ? { deleteBeforeTsMs } : {}),
    });
  }

  async finalizeDeletion(
    appId: string,
    generationId: string,
    deleteBeforeTsMs?: number,
  ): Promise<void> {
    const body = await this.postJson(appId, "/finalize-deletion", {
      appId,
      generationId,
      ...(deleteBeforeTsMs !== undefined ? { deleteBeforeTsMs } : {}),
    });
    if (!isRecord(body) || typeof body.done !== "boolean") {
      throw new HoldoverWriteAppInventoryError("finalize-deletion returned an invalid payload");
    }
    if (!body.done) {
      throw new HoldoverWriteAppInventoryError("finalize-deletion is incomplete");
    }
  }

  async markEntityPurged(appId: string, ref: HoldoverWriteAppEntityRef): Promise<void> {
    await this.post(appId, "/mark-entity-purged", ref);
  }

  async status(appId: string): Promise<HoldoverWriteAppInventoryStatus> {
    const stub = this.stub(appId);
    const response = await stub.fetch("https://holdover-write-app-inventory.local/status");
    if (!response.ok) {
      throw new HoldoverWriteAppInventoryError(`status returned HTTP ${String(response.status)}`);
    }
    const body: unknown = await response.json();
    if (
      !isRecord(body) ||
      typeof body.suppressed !== "boolean" ||
      typeof body.deletionComplete !== "boolean" ||
      !Array.isArray(body.entities)
    ) {
      throw new HoldoverWriteAppInventoryError("status returned an invalid payload");
    }
    return {
      generationId: typeof body.generationId === "string" ? body.generationId : null,
      suppressed: body.suppressed,
      deletionComplete: body.deletionComplete,
      deleteBeforeTsMs:
        typeof body.deleteBeforeTsMs === "number" && Number.isFinite(body.deleteBeforeTsMs)
          ? body.deleteBeforeTsMs
          : null,
      entities: body.entities.map(parseEntityRef),
      sagaPhase: parseSagaPhase(body.sagaPhase),
    };
  }

  async isSuppressed(appId: string): Promise<boolean> {
    const stub = this.stub(appId);
    const response = await stub.fetch("https://holdover-write-app-inventory.local/suppressed");
    if (!response.ok) {
      throw new HoldoverWriteAppInventoryError(
        `suppressed returned HTTP ${String(response.status)}`,
      );
    }
    const body: unknown = await response.json();
    return isRecord(body) && body.suppressed === true;
  }

  private stub(appId: string) {
    const name = holdoverWriteAppInventoryName(appId);
    return this.namespace.get(this.namespace.idFromName(name));
  }

  private async post(appId: string, path: string, body: unknown): Promise<void> {
    await this.postJson(appId, path, body);
  }

  private async postJson(appId: string, path: string, body: unknown): Promise<unknown> {
    const stub = this.stub(appId);
    let response: Response;
    try {
      response = await stub.fetch(`https://holdover-write-app-inventory.local${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (cause) {
      throw new HoldoverWriteAppInventoryError("app inventory transport failed", { cause });
    }
    if (!response.ok) {
      throw new HoldoverWriteAppInventoryError(
        `app inventory ${path} returned HTTP ${String(response.status)}`,
      );
    }
    return response.json();
  }
}

function parseEntityRef(value: unknown): HoldoverWriteAppEntityRef {
  if (!isRecord(value)) {
    throw new HoldoverWriteAppInventoryError("entity ref must be an object");
  }
  const idType = value.idType;
  const targetingKeyHash = value.targetingKeyHash;
  if (typeof idType !== "string" || idType.length === 0) {
    throw new HoldoverWriteAppInventoryError("entity ref idType is required");
  }
  if (typeof targetingKeyHash !== "string" || targetingKeyHash.length === 0) {
    throw new HoldoverWriteAppInventoryError("entity ref targetingKeyHash is required");
  }
  return { idType, targetingKeyHash };
}

function parseSagaPhase(value: unknown): HoldoverWriteAppDeletionSagaPhase | null {
  if (
    value === "preparing" ||
    value === "prepared" ||
    value === "d1_deleted" ||
    value === "finalizing" ||
    value === "completed" ||
    value === "canceling"
  ) {
    return value;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Inventory registration port used by Entity outbox ensure. */
export function inventoryRegisterPortForApp(
  client: HoldoverWriteAppInventoryClient,
  appId: string,
): HoldoverWriteInventoryRegisterPort {
  return {
    registerEntity: (ref) => client.registerEntity(appId, ref),
  };
}

/**
 * App-scoped durable inventory for holdover-write Entity outboxes (SPL-346).
 *
 * Strongly consistent registration + two-phase App deletion coordinator:
 * prepare/freeze suppresses new work without purging accepted durable jobs;
 * finalize drains every registered Entity outbox then marks complete; cancel
 * restores a still-live App so frozen jobs remain recoverable.
 *
 * @module
 */

export interface HoldoverWriteAppInventoryStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean | undefined>;
  list<T>(options?: { prefix?: string }): Promise<Map<string, T>>;
}

export interface HoldoverWriteAppEntityRef {
  readonly idType: string;
  readonly targetingKeyHash: string;
}

export interface HoldoverWriteAppDeletionBeginResult {
  readonly generationId: string | null;
  readonly suppressed: true;
  readonly deletionComplete: boolean;
  readonly entities: readonly HoldoverWriteAppEntityRef[];
  readonly deleteBeforeTsMs: number;
}

type HoldoverWriteAppInventorySagaPhase =
  | "preparing"
  | "prepared"
  | "d1_deleted"
  | "finalizing"
  | "completed"
  | "canceling";

export interface HoldoverWriteAppInventoryStatus {
  readonly generationId: string | null;
  readonly suppressed: boolean;
  readonly deletionComplete: boolean;
  readonly deleteBeforeTsMs: number | null;
  readonly entities: readonly HoldoverWriteAppEntityRef[];
  /** Durable App deletion saga phase; null when idle. */
  readonly sagaPhase: HoldoverWriteAppInventorySagaPhase | null;
}

/** Outcome of strongly consistent Entity registration against App deletion state. */
export type HoldoverWriteAppInventoryRegisterResult =
  | { readonly status: "registered" }
  | { readonly status: "suppressed" };

export interface HoldoverWriteAppInventoryNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  };
}

const ENTITY_PREFIX = "entity:";
const SUPPRESSED_KEY = "suppressed";
const DELETION_COMPLETE_KEY = "deletionComplete";
const DELETE_BEFORE_TS_KEY = "deleteBeforeTsMs";

export function holdoverWriteAppInventoryName(appId: string): string {
  if (appId.length === 0) {
    throw new Error("holdoverWriteAppInventoryName: appId is required");
  }
  return appId;
}

function entityInventoryKey(ref: HoldoverWriteAppEntityRef): string {
  return `${ENTITY_PREFIX}${ref.idType}:${ref.targetingKeyHash}`;
}

export async function registerAppInventoryEntity(
  storage: HoldoverWriteAppInventoryStorage,
  ref: HoldoverWriteAppEntityRef,
): Promise<HoldoverWriteAppInventoryRegisterResult> {
  requireEntityRef(ref);
  // App deletion suppress/complete is authoritative: refuse late registration so
  // a register-versus-complete race cannot leave an unindexed Entity outbox
  // after the App deletion coordinator reports complete.
  if ((await storage.get<boolean>(SUPPRESSED_KEY)) === true) {
    return { status: "suppressed" };
  }
  if ((await storage.get<boolean>(DELETION_COMPLETE_KEY)) === true) {
    return { status: "suppressed" };
  }
  await storage.put(entityInventoryKey(ref), ref);
  return { status: "registered" };
}

/**
 * Freeze/prepare: stop new registration and hot-path puts. Does not remove
 * Entity inventory rows or purge Entity outbox jobs — that is finalize.
 */
export async function beginAppInventoryDeletion(
  storage: HoldoverWriteAppInventoryStorage,
  deleteBeforeTsMs: number,
): Promise<HoldoverWriteAppDeletionBeginResult> {
  if (!Number.isFinite(deleteBeforeTsMs)) {
    throw new Error("beginAppInventoryDeletion: deleteBeforeTsMs must be finite");
  }
  const alreadyComplete = (await storage.get<boolean>(DELETION_COMPLETE_KEY)) === true;
  await storage.put(SUPPRESSED_KEY, true);
  await storage.put(DELETE_BEFORE_TS_KEY, deleteBeforeTsMs);
  if (alreadyComplete) {
    return {
      generationId: null,
      suppressed: true,
      deletionComplete: true,
      entities: [],
      deleteBeforeTsMs,
    };
  }
  await storage.delete(DELETION_COMPLETE_KEY);
  const entities = await listRegisteredEntities(storage);
  return {
    generationId: null,
    suppressed: true,
    deletionComplete: false,
    entities,
    deleteBeforeTsMs,
  };
}

/**
 * Cancel/restore: clear freeze on a still-live App so ownership and alarms can
 * resume. Refuses once deletion is marked complete (App D1 row is gone).
 */
export async function cancelAppInventoryDeletion(
  storage: HoldoverWriteAppInventoryStorage,
): Promise<{
  readonly cancelled: boolean;
  readonly entities: readonly HoldoverWriteAppEntityRef[];
}> {
  if ((await storage.get<boolean>(DELETION_COMPLETE_KEY)) === true) {
    return { cancelled: false, entities: [] };
  }
  await storage.delete(SUPPRESSED_KEY);
  await storage.delete(DELETE_BEFORE_TS_KEY);
  return { cancelled: true, entities: await listRegisteredEntities(storage) };
}

export async function markAppInventoryEntityPurged(
  storage: HoldoverWriteAppInventoryStorage,
  ref: HoldoverWriteAppEntityRef,
): Promise<void> {
  requireEntityRef(ref);
  await storage.delete(entityInventoryKey(ref));
}

export async function completeAppInventoryDeletion(
  storage: HoldoverWriteAppInventoryStorage,
): Promise<void> {
  const remaining = await listRegisteredEntities(storage);
  if (remaining.length > 0) {
    throw new Error(
      `completeAppInventoryDeletion: ${String(remaining.length)} Entity outbox(es) still registered`,
    );
  }
  await storage.put(SUPPRESSED_KEY, true);
  await storage.put(DELETION_COMPLETE_KEY, true);
  const prior = await storage.get<{
    appId?: string;
    generationId?: string;
    deleteBeforeTsMs?: number;
  }>("deletionSaga");
  const deleteBefore =
    typeof prior?.deleteBeforeTsMs === "number"
      ? prior.deleteBeforeTsMs
      : ((await storage.get<number>(DELETE_BEFORE_TS_KEY)) ?? 0);
  await storage.put("deletionSaga", {
    phase: "completed",
    appId: typeof prior?.appId === "string" ? prior.appId : "",
    generationId: typeof prior?.generationId === "string" ? prior.generationId : null,
    deleteBeforeTsMs: deleteBefore,
    cancelResumePending: [],
    cancelKvCleared: true,
  });
}

export async function appInventoryStatus(
  storage: HoldoverWriteAppInventoryStorage,
): Promise<HoldoverWriteAppInventoryStatus> {
  const deleteBefore = await storage.get<number>(DELETE_BEFORE_TS_KEY);
  const saga = await storage.get<{ phase?: unknown; generationId?: unknown }>("deletionSaga");
  const sagaPhase =
    saga !== undefined &&
    typeof saga === "object" &&
    saga !== null &&
    typeof saga.phase === "string" &&
    isSagaPhase(saga.phase)
      ? saga.phase
      : null;
  return {
    generationId: typeof saga?.generationId === "string" ? saga.generationId : null,
    suppressed: (await storage.get<boolean>(SUPPRESSED_KEY)) === true,
    deletionComplete: (await storage.get<boolean>(DELETION_COMPLETE_KEY)) === true,
    deleteBeforeTsMs:
      typeof deleteBefore === "number" && Number.isFinite(deleteBefore) ? deleteBefore : null,
    entities: await listRegisteredEntities(storage),
    sagaPhase,
  };
}

function isSagaPhase(value: string): value is HoldoverWriteAppInventorySagaPhase {
  return (
    value === "preparing" ||
    value === "prepared" ||
    value === "d1_deleted" ||
    value === "finalizing" ||
    value === "completed" ||
    value === "canceling"
  );
}

export async function isAppInventorySuppressed(
  storage: HoldoverWriteAppInventoryStorage,
): Promise<boolean> {
  return (await storage.get<boolean>(SUPPRESSED_KEY)) === true;
}

async function listRegisteredEntities(
  storage: HoldoverWriteAppInventoryStorage,
): Promise<HoldoverWriteAppEntityRef[]> {
  const listed = await storage.list<HoldoverWriteAppEntityRef>({ prefix: ENTITY_PREFIX });
  const entities: HoldoverWriteAppEntityRef[] = [];
  for (const value of listed.values()) {
    if (
      typeof value === "object" &&
      value !== null &&
      typeof value.idType === "string" &&
      value.idType.length > 0 &&
      typeof value.targetingKeyHash === "string" &&
      value.targetingKeyHash.length > 0
    ) {
      entities.push({ idType: value.idType, targetingKeyHash: value.targetingKeyHash });
    }
  }
  return entities;
}

function requireEntityRef(ref: HoldoverWriteAppEntityRef): void {
  if (ref.idType.length === 0 || ref.targetingKeyHash.length === 0) {
    throw new Error("HoldoverWriteAppEntityRef requires idType and targetingKeyHash");
  }
}

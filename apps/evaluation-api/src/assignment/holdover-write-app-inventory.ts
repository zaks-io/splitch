/**
 * App-scoped durable inventory for holdover-write Entity outboxes (SPL-346).
 *
 * Strongly consistent registration + deletion coordinator: App delete suppresses
 * first, enumerates pending/completed/poisoned Entity outboxes (including those
 * that never wrote Assignment Store KV), drains each, then marks complete so a
 * public retry can resume before Control Plane D1 cascade.
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
  readonly suppressed: true;
  readonly deletionComplete: boolean;
  readonly entities: readonly HoldoverWriteAppEntityRef[];
  readonly deleteBeforeTsMs: number;
}

export interface HoldoverWriteAppInventoryStatus {
  readonly suppressed: boolean;
  readonly deletionComplete: boolean;
  readonly deleteBeforeTsMs: number | null;
  readonly entities: readonly HoldoverWriteAppEntityRef[];
}

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
): Promise<void> {
  requireEntityRef(ref);
  await storage.put(entityInventoryKey(ref), ref);
}

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
      suppressed: true,
      deletionComplete: true,
      entities: [],
      deleteBeforeTsMs,
    };
  }
  await storage.delete(DELETION_COMPLETE_KEY);
  const entities = await listRegisteredEntities(storage);
  return {
    suppressed: true,
    deletionComplete: false,
    entities,
    deleteBeforeTsMs,
  };
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
}

export async function appInventoryStatus(
  storage: HoldoverWriteAppInventoryStorage,
): Promise<HoldoverWriteAppInventoryStatus> {
  const deleteBefore = await storage.get<number>(DELETE_BEFORE_TS_KEY);
  return {
    suppressed: (await storage.get<boolean>(SUPPRESSED_KEY)) === true,
    deletionComplete: (await storage.get<boolean>(DELETION_COMPLETE_KEY)) === true,
    deleteBeforeTsMs:
      typeof deleteBefore === "number" && Number.isFinite(deleteBefore) ? deleteBefore : null,
    entities: await listRegisteredEntities(storage),
  };
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

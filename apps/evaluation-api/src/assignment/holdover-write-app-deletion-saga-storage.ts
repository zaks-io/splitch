/**
 * Shared App deletion saga storage keys and helpers (SPL-346).
 *
 * @module
 */

import type {
  HoldoverWriteAppEntityRef,
  HoldoverWriteAppInventoryStorage,
} from "./holdover-write-app-inventory";

export type HoldoverWriteAppDeletionSagaPhase =
  | "preparing"
  | "prepared"
  | "d1_deleted"
  | "finalizing"
  | "completed"
  | "canceling";

export interface HoldoverWriteAppDeletionSaga {
  readonly phase: HoldoverWriteAppDeletionSagaPhase;
  readonly appId: string;
  /** Null only for saga records written before generation IDs shipped. */
  readonly generationId: string | null;
  readonly deleteBeforeTsMs: number;
  /** Entity outboxes still awaiting /resume-alarms during cancel. */
  readonly cancelResumePending: readonly HoldoverWriteAppEntityRef[];
  /** True once the App suppress KV tombstone delete has succeeded. */
  readonly cancelKvCleared: boolean;
}

export interface HoldoverWriteEntityAlarmResumePort {
  resumeAlarms(identity: {
    readonly appId: string;
    readonly idType: string;
    readonly targetingKeyHash: string;
  }): Promise<void>;
}

export interface HoldoverWriteEntityPurgePort {
  purgeEntity(deletion: {
    readonly appId: string;
    readonly idType: string;
    readonly targetingKeyHash: string;
    readonly deleteBeforeTsMs: number;
  }): Promise<void>;
}

export const SAGA_KEY = "deletionSaga";
const SAGA_ENTITY_PREFIX = "entity:";
export const SAGA_SUPPRESSED_KEY = "suppressed";
export const SAGA_DELETION_COMPLETE_KEY = "deletionComplete";
export const SAGA_DELETE_BEFORE_TS_KEY = "deleteBeforeTsMs";

export async function readAppDeletionSaga(
  storage: HoldoverWriteAppInventoryStorage,
): Promise<HoldoverWriteAppDeletionSaga | null> {
  const saga = await storage.get<HoldoverWriteAppDeletionSaga>(SAGA_KEY);
  return saga ?? null;
}

export async function putAppDeletionSaga(
  storage: HoldoverWriteAppInventoryStorage,
  saga: HoldoverWriteAppDeletionSaga,
): Promise<void> {
  await storage.put(SAGA_KEY, saga);
}

export async function adoptLegacyAppDeletionSagaGeneration(
  storage: HoldoverWriteAppInventoryStorage,
  saga: HoldoverWriteAppDeletionSaga,
  generationId: string,
): Promise<HoldoverWriteAppDeletionSaga> {
  if (saga.generationId !== null) return saga;
  const adopted = { ...saga, generationId };
  await putAppDeletionSaga(storage, adopted);
  return adopted;
}

export function appDeletionSagaCrossedBoundary(saga: HoldoverWriteAppDeletionSaga): boolean {
  return saga.phase === "d1_deleted" || saga.phase === "finalizing" || saga.phase === "completed";
}

export function sagaEntityInventoryKey(ref: HoldoverWriteAppEntityRef): string {
  return `${SAGA_ENTITY_PREFIX}${ref.idType}:${ref.targetingKeyHash}`;
}

export async function sagaListRegisteredEntities(
  storage: HoldoverWriteAppInventoryStorage,
): Promise<HoldoverWriteAppEntityRef[]> {
  const listed = await storage.list<HoldoverWriteAppEntityRef>({ prefix: SAGA_ENTITY_PREFIX });
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

export function requireSagaAppId(appId: string): void {
  if (appId.length === 0) throw new Error("app deletion saga: appId is required");
}

export function requireSagaGeneration(generationId: string): void {
  if (generationId.length === 0) throw new Error("app deletion saga: generationId is required");
}

export function requireSagaCutoff(deleteBeforeTsMs: number): void {
  if (!Number.isFinite(deleteBeforeTsMs)) {
    throw new Error("app deletion saga: deleteBeforeTsMs must be finite");
  }
}

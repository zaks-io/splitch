/**
 * D1-boundary + finalize drain steps for the App holdover deletion saga (SPL-346).
 *
 * @module
 */

import type { HoldoverWriteAppInventoryStorage } from "./holdover-write-app-inventory";
import {
  type HoldoverWriteAppDeletionSaga,
  type HoldoverWriteEntityPurgePort,
  SAGA_DELETE_BEFORE_TS_KEY,
  SAGA_DELETION_COMPLETE_KEY,
  SAGA_SUPPRESSED_KEY,
  putAppDeletionSaga,
  readAppDeletionSaga,
  requireSagaAppId,
  sagaEntityInventoryKey,
  sagaListRegisteredEntities,
} from "./holdover-write-app-deletion-saga-storage";

/** Record the irreversible D1-success boundary before Entity drain. */
export async function markAppDeletionSagaD1Deleted(
  storage: HoldoverWriteAppInventoryStorage,
  appId: string,
  deleteBeforeTsMs?: number,
): Promise<HoldoverWriteAppDeletionSaga> {
  requireSagaAppId(appId);
  const existing = await readAppDeletionSaga(storage);
  if (
    existing?.phase === "completed" ||
    (await storage.get<boolean>(SAGA_DELETION_COMPLETE_KEY)) === true
  ) {
    const completed: HoldoverWriteAppDeletionSaga = {
      phase: "completed",
      appId,
      deleteBeforeTsMs: existing?.deleteBeforeTsMs ?? deleteBeforeTsMs ?? 0,
      cancelResumePending: [],
      cancelKvCleared: true,
    };
    await putAppDeletionSaga(storage, completed);
    return completed;
  }
  if (existing?.phase === "d1_deleted" || existing?.phase === "finalizing") {
    return existing;
  }
  if (existing?.phase === "canceling") {
    throw new Error("markAppDeletionSagaD1Deleted: cancel in progress; refusing D1 boundary");
  }
  const cutoff =
    deleteBeforeTsMs ??
    existing?.deleteBeforeTsMs ??
    (await storage.get<number>(SAGA_DELETE_BEFORE_TS_KEY));
  if (typeof cutoff !== "number" || !Number.isFinite(cutoff)) {
    throw new Error("markAppDeletionSagaD1Deleted: deleteBeforeTsMs is required");
  }
  await storage.put(SAGA_SUPPRESSED_KEY, true);
  await storage.put(SAGA_DELETE_BEFORE_TS_KEY, cutoff);
  const saga: HoldoverWriteAppDeletionSaga = {
    phase: "d1_deleted",
    appId,
    deleteBeforeTsMs: cutoff,
    cancelResumePending: [],
    cancelKvCleared: false,
  };
  await putAppDeletionSaga(storage, saga);
  return saga;
}

/**
 * Finalize drain after D1 deletion. Checkpoints via Entity inventory removal;
 * refuses to cancel/rollback once d1_deleted.
 */
export async function advanceAppDeletionFinalizeSaga(
  storage: HoldoverWriteAppInventoryStorage,
  appId: string,
  purge: HoldoverWriteEntityPurgePort,
  deleteBeforeTsMs?: number,
): Promise<{ readonly done: boolean }> {
  requireSagaAppId(appId);
  if ((await storage.get<boolean>(SAGA_DELETION_COMPLETE_KEY)) === true) {
    return { done: true };
  }
  let saga = await readAppDeletionSaga(storage);
  if (saga?.phase === "canceling") {
    throw new Error("advanceAppDeletionFinalizeSaga: refuse finalize while canceling");
  }
  if (saga === null || saga.phase === "prepared" || saga.phase === "preparing") {
    saga = await markAppDeletionSagaD1Deleted(storage, appId, deleteBeforeTsMs);
  }
  if (saga.phase === "completed") {
    return { done: true };
  }

  const cutoff = deleteBeforeTsMs ?? saga.deleteBeforeTsMs;
  await putAppDeletionSaga(storage, { ...saga, phase: "finalizing", deleteBeforeTsMs: cutoff });

  const entities = await sagaListRegisteredEntities(storage);
  for (const entity of entities) {
    await purge.purgeEntity({
      appId,
      idType: entity.idType,
      targetingKeyHash: entity.targetingKeyHash,
      deleteBeforeTsMs: cutoff,
    });
    await storage.delete(sagaEntityInventoryKey(entity));
  }

  const remaining = await sagaListRegisteredEntities(storage);
  if (remaining.length > 0) {
    return { done: false };
  }
  await storage.put(SAGA_SUPPRESSED_KEY, true);
  await storage.put(SAGA_DELETION_COMPLETE_KEY, true);
  await putAppDeletionSaga(storage, {
    phase: "completed",
    appId,
    deleteBeforeTsMs: cutoff,
    cancelResumePending: [],
    cancelKvCleared: true,
  });
  return { done: true };
}

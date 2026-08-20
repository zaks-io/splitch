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
  adoptLegacyAppDeletionSagaGeneration,
  putAppDeletionSaga,
  readAppDeletionSaga,
  requireSagaAppId,
  requireSagaGeneration,
  sagaEntityInventoryKey,
  sagaListRegisteredEntities,
} from "./holdover-write-app-deletion-saga-storage";

/** Record the irreversible D1-success boundary before Entity drain. */
export async function markAppDeletionSagaD1Deleted(
  storage: HoldoverWriteAppInventoryStorage,
  appId: string,
  generationId: string,
  deleteBeforeTsMs?: number,
): Promise<HoldoverWriteAppDeletionSaga> {
  requireSagaAppId(appId);
  requireSagaGeneration(generationId);
  const stored = await readAppDeletionSaga(storage);
  const existing =
    stored === null
      ? null
      : await adoptLegacyAppDeletionSagaGeneration(storage, stored, generationId);
  if (existing !== null && existing.generationId !== generationId) {
    throw new Error("markAppDeletionSagaD1Deleted: generation does not match active saga");
  }
  if (
    existing?.phase === "completed" ||
    (await storage.get<boolean>(SAGA_DELETION_COMPLETE_KEY)) === true
  ) {
    const completed = completedSaga(appId, generationId, existing, deleteBeforeTsMs);
    await putAppDeletionSaga(storage, completed);
    return completed;
  }
  if (existing?.phase === "d1_deleted" || existing?.phase === "finalizing") {
    return existing;
  }
  if (existing?.phase === "canceling") {
    throw new Error("markAppDeletionSagaD1Deleted: cancel in progress; refusing D1 boundary");
  }
  const cutoff = await requireDeletionCutoff(storage, existing, deleteBeforeTsMs);
  await storage.put(SAGA_SUPPRESSED_KEY, true);
  await storage.put(SAGA_DELETE_BEFORE_TS_KEY, cutoff);
  const saga: HoldoverWriteAppDeletionSaga = {
    phase: "d1_deleted",
    appId,
    generationId,
    deleteBeforeTsMs: cutoff,
    cancelResumePending: [],
    cancelKvCleared: false,
  };
  await putAppDeletionSaga(storage, saga);
  return saga;
}

function completedSaga(
  appId: string,
  generationId: string,
  existing: HoldoverWriteAppDeletionSaga | null,
  deleteBeforeTsMs: number | undefined,
): HoldoverWriteAppDeletionSaga {
  return {
    phase: "completed",
    appId,
    generationId,
    deleteBeforeTsMs: existing?.deleteBeforeTsMs ?? deleteBeforeTsMs ?? 0,
    cancelResumePending: [],
    cancelKvCleared: true,
  };
}

async function requireDeletionCutoff(
  storage: HoldoverWriteAppInventoryStorage,
  existing: HoldoverWriteAppDeletionSaga | null,
  deleteBeforeTsMs: number | undefined,
): Promise<number> {
  const cutoff =
    deleteBeforeTsMs ??
    existing?.deleteBeforeTsMs ??
    (await storage.get<number>(SAGA_DELETE_BEFORE_TS_KEY));
  if (typeof cutoff !== "number" || !Number.isFinite(cutoff)) {
    throw new Error("markAppDeletionSagaD1Deleted: deleteBeforeTsMs is required");
  }
  return cutoff;
}

/**
 * Finalize drain after D1 deletion. Checkpoints via Entity inventory removal;
 * refuses to cancel/rollback once d1_deleted.
 */
export async function advanceAppDeletionFinalizeSaga(
  storage: HoldoverWriteAppInventoryStorage,
  appId: string,
  generationId: string | null,
  purge: HoldoverWriteEntityPurgePort,
  deleteBeforeTsMs?: number,
): Promise<{ readonly done: boolean }> {
  requireSagaAppId(appId);
  if (generationId !== null) requireSagaGeneration(generationId);
  const deletionComplete = (await storage.get<boolean>(SAGA_DELETION_COMPLETE_KEY)) === true;
  let saga = await loadFinalizeSaga(
    storage,
    appId,
    generationId,
    deleteBeforeTsMs,
    deletionComplete,
  );
  requireMatchingFinalizeGeneration(saga, generationId);
  if (deletionComplete) return { done: true };
  saga = await enterFinalizeBoundary(storage, appId, generationId, deleteBeforeTsMs, saga);
  if (saga.phase === "completed") {
    return { done: true };
  }

  const cutoff = deleteBeforeTsMs ?? saga.deleteBeforeTsMs;
  await putAppDeletionSaga(storage, { ...saga, phase: "finalizing", deleteBeforeTsMs: cutoff });

  await purgeRegisteredEntities(storage, appId, cutoff, purge);

  const remaining = await sagaListRegisteredEntities(storage);
  if (remaining.length > 0) {
    return { done: false };
  }
  await storage.put(SAGA_SUPPRESSED_KEY, true);
  await storage.put(SAGA_DELETION_COMPLETE_KEY, true);
  await putAppDeletionSaga(storage, {
    phase: "completed",
    appId,
    generationId: saga.generationId,
    deleteBeforeTsMs: cutoff,
    cancelResumePending: [],
    cancelKvCleared: true,
  });
  return { done: true };
}

async function loadFinalizeSaga(
  storage: HoldoverWriteAppInventoryStorage,
  appId: string,
  generationId: string | null,
  deleteBeforeTsMs: number | undefined,
  deletionComplete: boolean,
): Promise<HoldoverWriteAppDeletionSaga | null> {
  let saga = await readAppDeletionSaga(storage);
  if (saga === null && deletionComplete && generationId !== null) {
    saga = completedSaga(appId, generationId, null, deleteBeforeTsMs);
    await putAppDeletionSaga(storage, saga);
  }
  if (saga !== null && generationId !== null) {
    saga = await adoptLegacyAppDeletionSagaGeneration(storage, saga, generationId);
  }
  return saga;
}

function requireMatchingFinalizeGeneration(
  saga: HoldoverWriteAppDeletionSaga | null,
  generationId: string | null,
): void {
  if (saga !== null && generationId !== null && saga.generationId !== generationId) {
    throw new Error("advanceAppDeletionFinalizeSaga: generation does not match active saga");
  }
}

async function enterFinalizeBoundary(
  storage: HoldoverWriteAppInventoryStorage,
  appId: string,
  generationId: string | null,
  deleteBeforeTsMs: number | undefined,
  saga: HoldoverWriteAppDeletionSaga | null,
): Promise<HoldoverWriteAppDeletionSaga> {
  if (saga?.phase === "canceling") {
    throw new Error("advanceAppDeletionFinalizeSaga: refuse finalize while canceling");
  }
  if (saga !== null && saga.phase !== "prepared" && saga.phase !== "preparing") return saga;
  if (generationId === null) {
    throw new Error("advanceAppDeletionFinalizeSaga: generation is required before D1 boundary");
  }
  return markAppDeletionSagaD1Deleted(storage, appId, generationId, deleteBeforeTsMs);
}

async function purgeRegisteredEntities(
  storage: HoldoverWriteAppInventoryStorage,
  appId: string,
  deleteBeforeTsMs: number,
  purge: HoldoverWriteEntityPurgePort,
): Promise<void> {
  const entities = await sagaListRegisteredEntities(storage);
  for (const entity of entities) {
    await purge.purgeEntity({
      appId,
      idType: entity.idType,
      targetingKeyHash: entity.targetingKeyHash,
      deleteBeforeTsMs,
    });
    await storage.delete(sagaEntityInventoryKey(entity));
  }
}

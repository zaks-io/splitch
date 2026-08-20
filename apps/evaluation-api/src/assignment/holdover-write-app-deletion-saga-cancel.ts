/**
 * Durable cancel/restore steps for the App holdover deletion saga (SPL-346).
 *
 * @module
 */

import type { AssignmentKv } from "./assignment-store";
import type { HoldoverWriteAppInventoryStorage } from "./holdover-write-app-inventory";
import { appHoldoverWriteSuppressKey } from "./holdover-write-outbox-core";
import {
  type HoldoverWriteEntityAlarmResumePort,
  SAGA_DELETE_BEFORE_TS_KEY,
  SAGA_DELETION_COMPLETE_KEY,
  SAGA_KEY,
  SAGA_SUPPRESSED_KEY,
  putAppDeletionSaga,
  readAppDeletionSaga,
  requireSagaAppId,
  sagaListRegisteredEntities,
} from "./holdover-write-app-deletion-saga-storage";

/**
 * Durable cancel: resume Entity alarms with per-Entity checkpoints, clear KV
 * tombstone, then clear DO suppress. Idempotent and alarm-resumable.
 */
export async function beginOrResumeAppDeletionCancelSaga(
  storage: HoldoverWriteAppInventoryStorage,
  kv: AssignmentKv,
  appId: string,
  resume: HoldoverWriteEntityAlarmResumePort | null,
): Promise<{ readonly done: boolean; readonly cancelled: boolean }> {
  requireSagaAppId(appId);
  if ((await storage.get<boolean>(SAGA_DELETION_COMPLETE_KEY)) === true) {
    return { done: true, cancelled: false };
  }
  const existing = await readAppDeletionSaga(storage);
  if (existing?.phase === "d1_deleted" || existing?.phase === "finalizing") {
    return { done: true, cancelled: false };
  }
  if (existing?.phase === "completed") {
    return { done: true, cancelled: false };
  }
  if (existing === null && (await storage.get<boolean>(SAGA_SUPPRESSED_KEY)) !== true) {
    return { done: true, cancelled: true };
  }

  const deleteBeforeTsMs =
    existing?.deleteBeforeTsMs ?? (await storage.get<number>(SAGA_DELETE_BEFORE_TS_KEY)) ?? 0;
  const pending =
    existing?.phase === "canceling"
      ? existing.cancelResumePending
      : await sagaListRegisteredEntities(storage);
  await putAppDeletionSaga(storage, {
    phase: "canceling",
    appId,
    deleteBeforeTsMs,
    cancelResumePending: pending,
    cancelKvCleared: existing?.phase === "canceling" ? existing.cancelKvCleared : false,
  });
  const advanced = await advanceAppDeletionCancelSaga(storage, kv, appId, resume);
  return { done: advanced.done, cancelled: true };
}

export async function advanceAppDeletionCancelSaga(
  storage: HoldoverWriteAppInventoryStorage,
  kv: AssignmentKv,
  appId: string,
  resume: HoldoverWriteEntityAlarmResumePort | null,
): Promise<{ readonly done: boolean }> {
  const saga = await readAppDeletionSaga(storage);
  if (saga === null || saga.phase !== "canceling") {
    return { done: true };
  }

  let pending = [...saga.cancelResumePending];
  let cancelKvCleared = saga.cancelKvCleared;
  while (pending.length > 0) {
    if (!resume) {
      return { done: false };
    }
    const [next, ...rest] = pending;
    if (!next) break;
    await resume.resumeAlarms({
      appId,
      idType: next.idType,
      targetingKeyHash: next.targetingKeyHash,
    });
    pending = rest;
    await putAppDeletionSaga(storage, {
      phase: "canceling",
      appId: saga.appId,
      deleteBeforeTsMs: saga.deleteBeforeTsMs,
      cancelResumePending: pending,
      cancelKvCleared,
    });
  }

  if (!cancelKvCleared) {
    const deleteKey = kv.delete?.bind(kv);
    if (!deleteKey) {
      throw new Error("ASSIGNMENTS_KV.delete is required to cancel App holdover suppress");
    }
    await deleteKey(appHoldoverWriteSuppressKey(appId));
    cancelKvCleared = true;
    await putAppDeletionSaga(storage, {
      phase: "canceling",
      appId: saga.appId,
      deleteBeforeTsMs: saga.deleteBeforeTsMs,
      cancelResumePending: [],
      cancelKvCleared: true,
    });
  }

  await storage.delete(SAGA_SUPPRESSED_KEY);
  await storage.delete(SAGA_DELETE_BEFORE_TS_KEY);
  await storage.delete(SAGA_KEY);
  return { done: true };
}

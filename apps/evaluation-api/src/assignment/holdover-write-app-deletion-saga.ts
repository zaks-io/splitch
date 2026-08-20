/**
 * Durable App-scoped holdover deletion saga (SPL-346).
 *
 * Persists outside the D1 App row (App inventory DO storage) so prepare/cancel/
 * finalize can resume without request-local compensation. Phases:
 * preparing → prepared → (canceling → idle) | (d1_deleted → finalizing → completed).
 *
 * @module
 */

import type { AssignmentKv } from "./assignment-store";
import type {
  HoldoverWriteAppEntityRef,
  HoldoverWriteAppInventoryStorage,
} from "./holdover-write-app-inventory";
import { appHoldoverWriteSuppressKey } from "./holdover-write-outbox-core";
import {
  advanceAppDeletionCancelSaga,
  beginOrResumeAppDeletionCancelSaga,
} from "./holdover-write-app-deletion-saga-cancel";
import {
  advanceAppDeletionFinalizeSaga,
  markAppDeletionSagaD1Deleted,
} from "./holdover-write-app-deletion-saga-finalize";
import {
  type HoldoverWriteAppDeletionSaga,
  type HoldoverWriteEntityAlarmResumePort,
  SAGA_DELETE_BEFORE_TS_KEY,
  SAGA_DELETION_COMPLETE_KEY,
  SAGA_SUPPRESSED_KEY,
  adoptLegacyAppDeletionSagaGeneration,
  appDeletionSagaCrossedBoundary,
  putAppDeletionSaga,
  readAppDeletionSaga,
  requireSagaAppId,
  requireSagaCutoff,
  requireSagaGeneration,
  sagaListRegisteredEntities,
} from "./holdover-write-app-deletion-saga-storage";

export type {
  HoldoverWriteAppDeletionSagaPhase,
  HoldoverWriteEntityAlarmResumePort,
} from "./holdover-write-app-deletion-saga-storage";
export {
  advanceAppDeletionCancelSaga,
  advanceAppDeletionFinalizeSaga,
  beginOrResumeAppDeletionCancelSaga,
  markAppDeletionSagaD1Deleted,
  readAppDeletionSaga,
};

/**
 * Failure-atomic prepare: persist preparing + DO suppress, then KV put.
 * On KV failure, enter durable canceling and attempt cancel progress before
 * returning — never leave a live App registration-suppressed without a saga.
 */
export async function prepareAppDeletionSaga(
  storage: HoldoverWriteAppInventoryStorage,
  kv: AssignmentKv,
  appId: string,
  generationId: string,
  deleteBeforeTsMs: number,
  resume: HoldoverWriteEntityAlarmResumePort | null,
): Promise<{ readonly suppressed: true; readonly deletionComplete: boolean }> {
  requireSagaAppId(appId);
  requireSagaGeneration(generationId);
  requireSagaCutoff(deleteBeforeTsMs);
  const early = await prepareSagaEarlyReturn(storage, kv, appId, generationId, resume);
  if (early) return early;

  const entities = await sagaListRegisteredEntities(storage);
  await writePreparingFreeze(storage, appId, generationId, deleteBeforeTsMs, entities);

  try {
    await kv.put(appHoldoverWriteSuppressKey(appId), "1");
  } catch (cause) {
    await failPrepareIntoCancel(
      storage,
      kv,
      appId,
      generationId,
      deleteBeforeTsMs,
      entities,
      resume,
      cause,
    );
  }

  await putAppDeletionSaga(storage, {
    phase: "prepared",
    appId,
    generationId,
    deleteBeforeTsMs,
    cancelResumePending: [],
    cancelKvCleared: false,
  });
  return { suppressed: true, deletionComplete: false };
}

async function prepareSagaEarlyReturn(
  storage: HoldoverWriteAppInventoryStorage,
  kv: AssignmentKv,
  appId: string,
  generationId: string,
  resume: HoldoverWriteEntityAlarmResumePort | null,
): Promise<{ readonly suppressed: true; readonly deletionComplete: boolean } | null> {
  const stored = await readAppDeletionSaga(storage);
  const existing =
    stored === null
      ? null
      : await adoptLegacyAppDeletionSagaGeneration(storage, stored, generationId);
  if (existing !== null && existing.generationId !== generationId) {
    return supersedePreparedSaga(storage, kv, appId, existing, resume);
  }
  return sameGenerationPrepareEarlyReturn(storage, kv, appId, existing, resume);
}

async function supersedePreparedSaga(
  storage: HoldoverWriteAppInventoryStorage,
  kv: AssignmentKv,
  appId: string,
  existing: HoldoverWriteAppDeletionSaga,
  resume: HoldoverWriteEntityAlarmResumePort | null,
): Promise<null> {
  if (appDeletionSagaCrossedBoundary(existing)) {
    throw new Error("prepareAppDeletionSaga: another generation crossed the D1 boundary");
  }
  if (existing.phase === "preparing" || existing.phase === "canceling") {
    const advanced = await beginOrResumeAppDeletionCancelSaga(storage, kv, appId, resume);
    if (!advanced.done) {
      throw new Error("prepareAppDeletionSaga: prior generation cancel still in progress");
    }
  }
  return null;
}

async function sameGenerationPrepareEarlyReturn(
  storage: HoldoverWriteAppInventoryStorage,
  kv: AssignmentKv,
  appId: string,
  existing: HoldoverWriteAppDeletionSaga | null,
  resume: HoldoverWriteEntityAlarmResumePort | null,
): Promise<{ readonly suppressed: true; readonly deletionComplete: boolean } | null> {
  if (
    existing?.phase === "completed" ||
    (await storage.get<boolean>(SAGA_DELETION_COMPLETE_KEY)) === true
  ) {
    await storage.put(SAGA_SUPPRESSED_KEY, true);
    await storage.put(SAGA_DELETION_COMPLETE_KEY, true);
    return { suppressed: true, deletionComplete: true };
  }
  if (
    existing?.phase === "prepared" ||
    existing?.phase === "d1_deleted" ||
    existing?.phase === "finalizing"
  ) {
    return { suppressed: true, deletionComplete: false };
  }
  if (existing?.phase === "canceling") {
    const advanced = await advanceAppDeletionCancelSaga(storage, kv, appId, resume);
    if (!advanced.done) {
      throw new Error("prepareAppDeletionSaga: prior cancel still in progress");
    }
  }
  return null;
}

async function writePreparingFreeze(
  storage: HoldoverWriteAppInventoryStorage,
  appId: string,
  generationId: string,
  deleteBeforeTsMs: number,
  entities: readonly HoldoverWriteAppEntityRef[],
): Promise<void> {
  await putAppDeletionSaga(storage, {
    phase: "preparing",
    appId,
    generationId,
    deleteBeforeTsMs,
    cancelResumePending: entities,
    cancelKvCleared: false,
  });
  await storage.put(SAGA_SUPPRESSED_KEY, true);
  await storage.put(SAGA_DELETE_BEFORE_TS_KEY, deleteBeforeTsMs);
  await storage.delete(SAGA_DELETION_COMPLETE_KEY);
}

async function failPrepareIntoCancel(
  storage: HoldoverWriteAppInventoryStorage,
  kv: AssignmentKv,
  appId: string,
  generationId: string,
  deleteBeforeTsMs: number,
  entities: readonly HoldoverWriteAppEntityRef[],
  resume: HoldoverWriteEntityAlarmResumePort | null,
  cause: unknown,
): Promise<never> {
  await putAppDeletionSaga(storage, {
    phase: "canceling",
    appId,
    generationId,
    deleteBeforeTsMs,
    cancelResumePending: entities,
    cancelKvCleared: false,
  });
  const advanced = await advanceAppDeletionCancelSaga(storage, kv, appId, resume);
  if (!advanced.done) {
    throw new Error(
      `prepareAppDeletionSaga: KV freeze failed and cancel is incomplete: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
  }
  throw cause;
}

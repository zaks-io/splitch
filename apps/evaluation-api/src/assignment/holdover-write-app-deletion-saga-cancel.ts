/**
 * Durable cancel/restore steps for the App holdover deletion saga (SPL-346).
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
  type HoldoverWriteAppDeletionSaga,
  type HoldoverWriteEntityAlarmResumePort,
  SAGA_DELETE_BEFORE_TS_KEY,
  SAGA_DELETION_COMPLETE_KEY,
  SAGA_KEY,
  SAGA_SUPPRESSED_KEY,
  adoptLegacyAppDeletionSagaGeneration,
  appDeletionSagaCrossedBoundary,
  putAppDeletionSaga,
  readAppDeletionSaga,
  requireSagaAppId,
  requireSagaGeneration,
  sagaListRegisteredEntities,
} from "./holdover-write-app-deletion-saga-storage";

export interface HoldoverWriteAppDeletionCancelStep {
  readonly appId: string;
  readonly generationId: string | null;
  readonly entity: HoldoverWriteAppEntityRef;
}

export interface HoldoverWriteAppDeletionCancelPlan {
  readonly done: boolean;
  readonly cancelled: boolean;
  readonly step: HoldoverWriteAppDeletionCancelStep | null;
}

/**
 * Durable cancel: clear the KV tombstone, then resume Entity alarms with
 * per-Entity checkpoints, then clear DO suppress. Idempotent and alarm-resumable.
 */
export async function beginOrResumeAppDeletionCancelSaga(
  storage: HoldoverWriteAppInventoryStorage,
  kv: AssignmentKv,
  appId: string,
  resume: HoldoverWriteEntityAlarmResumePort | null,
  expectedGenerationId?: string,
): Promise<{ readonly done: boolean; readonly cancelled: boolean }> {
  requireSagaAppId(appId);
  if (expectedGenerationId !== undefined) requireSagaGeneration(expectedGenerationId);
  if ((await storage.get<boolean>(SAGA_DELETION_COMPLETE_KEY)) === true) {
    return { done: true, cancelled: false };
  }
  let existing = await readAppDeletionSaga(storage);
  if (existing !== null && expectedGenerationId !== undefined) {
    existing = await adoptLegacyAppDeletionSagaGeneration(storage, existing, expectedGenerationId);
  }
  if (
    existing !== null &&
    expectedGenerationId !== undefined &&
    existing.generationId !== expectedGenerationId
  ) {
    return { done: true, cancelled: false };
  }
  if (existing !== null && appDeletionSagaCrossedBoundary(existing)) {
    return { done: true, cancelled: false };
  }
  if (existing === null && (await storage.get<boolean>(SAGA_SUPPRESSED_KEY)) !== true) {
    return { done: true, cancelled: true };
  }

  await putAppDeletionSaga(
    storage,
    await buildCancelingSaga(storage, appId, existing, expectedGenerationId),
  );
  const advanced = await advanceAppDeletionCancelSaga(storage, kv, appId, resume);
  return { done: advanced.done, cancelled: true };
}

/** Select one child-DO resume hop after durable cancel setup and KV clear. */
export async function planAppDeletionCancelStep(
  storage: HoldoverWriteAppInventoryStorage,
  kv: AssignmentKv,
  appId: string,
  expectedGenerationId?: string,
): Promise<HoldoverWriteAppDeletionCancelPlan> {
  const result = await beginOrResumeAppDeletionCancelSaga(
    storage,
    kv,
    appId,
    null,
    expectedGenerationId,
  );
  if (result.done || !result.cancelled) return { ...result, step: null };
  const saga = await readAppDeletionSaga(storage);
  if (saga?.phase !== "canceling") return { ...result, step: null };
  const entity = saga.cancelResumePending[0];
  if (!entity) return { ...result, step: null };
  return {
    ...result,
    step: { appId, generationId: saga.generationId, entity },
  };
}

/** Checkpoint one completed child-DO resume hop without awaiting another DO. */
export async function checkpointAppDeletionCancelStep(
  storage: HoldoverWriteAppInventoryStorage,
  step: HoldoverWriteAppDeletionCancelStep,
): Promise<{ readonly done: boolean }> {
  const saga = await readAppDeletionSaga(storage);
  if (saga === null || saga.phase !== "canceling" || saga.generationId !== step.generationId) {
    return { done: false };
  }
  const pending = saga.cancelResumePending.filter((entity) => !sameEntity(entity, step.entity));
  if (pending.length > 0) {
    await putAppDeletionSaga(storage, { ...saga, cancelResumePending: pending });
    return { done: false };
  }
  await storage.delete(SAGA_SUPPRESSED_KEY);
  await storage.delete(SAGA_DELETE_BEFORE_TS_KEY);
  await storage.delete(SAGA_KEY);
  return { done: true };
}

function sameEntity(left: HoldoverWriteAppEntityRef, right: HoldoverWriteAppEntityRef): boolean {
  return left.idType === right.idType && left.targetingKeyHash === right.targetingKeyHash;
}

async function buildCancelingSaga(
  storage: HoldoverWriteAppInventoryStorage,
  appId: string,
  existing: HoldoverWriteAppDeletionSaga | null,
  expectedGenerationId: string | undefined,
): Promise<HoldoverWriteAppDeletionSaga> {
  const deleteBeforeTsMs =
    existing?.deleteBeforeTsMs ?? (await storage.get<number>(SAGA_DELETE_BEFORE_TS_KEY)) ?? 0;
  const pending =
    existing?.phase === "canceling"
      ? existing.cancelResumePending
      : await sagaListRegisteredEntities(storage);
  return {
    phase: "canceling",
    appId,
    generationId: existing?.generationId ?? expectedGenerationId ?? null,
    deleteBeforeTsMs,
    cancelResumePending: pending,
    cancelKvCleared: existing?.phase === "canceling" ? existing.cancelKvCleared : false,
  };
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

  const pending = [...saga.cancelResumePending];
  let cancelKvCleared = saga.cancelKvCleared;
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
      generationId: saga.generationId,
      deleteBeforeTsMs: saga.deleteBeforeTsMs,
      cancelResumePending: pending,
      cancelKvCleared: true,
    });
  }

  if (!resume && pending.length > 0) return { done: false };

  const currentSaga = { ...saga, cancelKvCleared };
  const failed = await resumePendingEntityAlarms(storage, currentSaga, appId, resume, pending);
  if (failed.length > 0) return { done: false };

  await storage.delete(SAGA_SUPPRESSED_KEY);
  await storage.delete(SAGA_DELETE_BEFORE_TS_KEY);
  await storage.delete(SAGA_KEY);
  return { done: true };
}

async function resumePendingEntityAlarms(
  storage: HoldoverWriteAppInventoryStorage,
  saga: HoldoverWriteAppDeletionSaga,
  appId: string,
  resume: HoldoverWriteEntityAlarmResumePort | null,
  pending: readonly HoldoverWriteAppEntityRef[],
): Promise<readonly HoldoverWriteAppEntityRef[]> {
  const failed: HoldoverWriteAppEntityRef[] = [];
  for (const [index, entity] of pending.entries()) {
    try {
      await resume?.resumeAlarms({
        appId,
        idType: entity.idType,
        targetingKeyHash: entity.targetingKeyHash,
      });
    } catch {
      failed.push(entity);
    }
    await putAppDeletionSaga(storage, {
      phase: "canceling",
      appId: saga.appId,
      generationId: saga.generationId,
      deleteBeforeTsMs: saga.deleteBeforeTsMs,
      cancelResumePending: [...failed, ...pending.slice(index + 1)],
      cancelKvCleared: saga.cancelKvCleared,
    });
  }
  return failed;
}

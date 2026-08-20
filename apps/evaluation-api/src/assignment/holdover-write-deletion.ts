/**
 * Privacy deletion consumer for the holdover-write outbox (SPL-346).
 *
 * App deletion is a durable App-scoped saga owned by App inventory DO storage
 * (outside the D1 App row): prepare/freeze, cancel restore, or mark D1-deleted
 * then finalize drain.
 *
 * @module
 */

import type { AssignmentKv } from "./assignment-store";
import type { HoldoverWriteAppInventoryClient } from "./holdover-write-app-inventory-client";
import type { HoldoverWriteOutboxNamespace } from "./holdover-write-outbox";
import { appHoldoverWriteSuppressKey, holdoverWriteOutboxName } from "./holdover-write-outbox-core";

type HoldoverWriteEntityIdentity = {
  readonly appId: string;
  readonly idType: string;
  readonly targetingKeyHash: string;
};

export type EntityHoldoverWriteDeletion = HoldoverWriteEntityIdentity & {
  /** Inclusive cutoff: jobs / ensures at or before this ms are stale. */
  readonly deleteBeforeTsMs: number;
};

/** Immediate App freeze helper: hot-path KV tombstone only (inventory DO also writes this). */
export async function suppressAppHoldoverWriteOutbox(
  kv: AssignmentKv,
  appId: string,
): Promise<void> {
  if (appId.length === 0) {
    throw new Error("suppressAppHoldoverWriteOutbox: appId is required");
  }
  await kv.put(appHoldoverWriteSuppressKey(appId), "1");
}

/**
 * Entity privacy deletion handshake: cutoff suppress, wait for any in-flight
 * stale put (DO concurrency), purge stale jobs, and unregister inventory.
 */
export async function suppressAndPurgeEntityHoldoverWriteOutbox(
  namespace: HoldoverWriteOutboxNamespace,
  deletion: EntityHoldoverWriteDeletion,
): Promise<void> {
  if (!Number.isFinite(deletion.deleteBeforeTsMs)) {
    throw new Error("suppressAndPurgeEntityHoldoverWriteOutbox: deleteBeforeTsMs is required");
  }
  const name = holdoverWriteOutboxName(deletion);
  const stub = namespace.get(namespace.idFromName(name));
  const response = await stub.fetch("https://holdover-write-outbox.local/delete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      deleteBeforeTsMs: deletion.deleteBeforeTsMs,
      appId: deletion.appId,
      idType: deletion.idType,
      targetingKeyHash: deletion.targetingKeyHash,
    }),
  });
  if (!response.ok) {
    throw new Error(`holdover write outbox /delete failed: HTTP ${String(response.status)}`);
  }
}

/** Phase 1: freeze App holdover work without purging accepted durable jobs. */
export async function prepareAppHoldoverWriteDeletion(
  inventory: HoldoverWriteAppInventoryClient,
  appId: string,
  generationId: string,
  deleteBeforeTsMs: number,
): Promise<void> {
  requireAppDeletionArgs(appId, deleteBeforeTsMs, "prepareAppHoldoverWriteDeletion");
  requireGeneration(generationId, "prepareAppHoldoverWriteDeletion");
  await inventory.beginDeletion(appId, generationId, deleteBeforeTsMs);
}

/** Irreversible boundary after Control Plane `deleteAppCascade` commits. */
export async function markAppHoldoverWriteD1Deleted(
  inventory: HoldoverWriteAppInventoryClient,
  appId: string,
  generationId: string,
  deleteBeforeTsMs?: number,
): Promise<void> {
  if (appId.length === 0) {
    throw new Error("markAppHoldoverWriteD1Deleted: appId is required");
  }
  requireGeneration(generationId, "markAppHoldoverWriteD1Deleted");
  await inventory.markD1Deleted(appId, generationId, deleteBeforeTsMs);
}

/**
 * Cancel/restore when still pre-D1. Inventory DO owns durable checkpoints and
 * alarm resume; incomplete cancel fails loud so the DO alarm continues without
 * a browser request.
 */
export async function cancelAppHoldoverWriteDeletion(
  inventory: HoldoverWriteAppInventoryClient,
  appId: string,
  generationId: string,
): Promise<void> {
  if (appId.length === 0) {
    throw new Error("cancelAppHoldoverWriteDeletion: appId is required");
  }
  requireGeneration(generationId, "cancelAppHoldoverWriteDeletion");
  const status = await inventory.status(appId);
  if (status.generationId !== null && status.generationId !== generationId) return;
  if (status.sagaPhase === "d1_deleted" || status.sagaPhase === "finalizing") {
    throw new Error("cancelAppHoldoverWriteDeletion: refuse cancel after D1 deletion");
  }
  if (status.deletionComplete || status.sagaPhase === "completed") {
    return;
  }
  const cancelled = await inventory.cancelDeletion(appId, generationId);
  if (!cancelled.cancelled) {
    return;
  }
  if (!cancelled.done) {
    // Leave the canceling saga for the inventory DO alarm to resume.
    throw new Error(
      "cancelAppHoldoverWriteDeletion: cancel saga incomplete; will resume via alarm",
    );
  }
}

function requireAppDeletionArgs(appId: string, deleteBeforeTsMs: number, label: string): void {
  if (appId.length === 0) {
    throw new Error(`${label}: appId is required`);
  }
  if (!Number.isFinite(deleteBeforeTsMs)) {
    throw new Error(`${label}: deleteBeforeTsMs is required`);
  }
}

function requireGeneration(generationId: string, label: string): void {
  if (generationId.length === 0) throw new Error(`${label}: generationId is required`);
}

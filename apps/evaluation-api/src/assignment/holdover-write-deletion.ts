/**
 * Privacy deletion consumer for the holdover-write outbox (SPL-346).
 *
 * App deletion is reversible two-phase: prepare/freeze (suppress without purge),
 * Control Plane D1/credential cascade, then finalize (drain/purge + complete).
 * Cancel restores a still-live App so frozen durable jobs remain recoverable.
 *
 * Entity deletion: cutoff-aware suppress + purge on that Entity's outbox DO,
 * which also unregisters the Entity from App inventory under the same
 * `blockConcurrencyWhile` critical section.
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

/** Wake pending Entity outbox alarms after App deletion cancel/restore. */
async function resumeEntityHoldoverWriteOutboxAlarms(
  namespace: HoldoverWriteOutboxNamespace,
  identity: HoldoverWriteEntityIdentity,
): Promise<void> {
  const name = holdoverWriteOutboxName(identity);
  const stub = namespace.get(namespace.idFromName(name));
  const response = await stub.fetch("https://holdover-write-outbox.local/resume-alarms", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (!response.ok) {
    throw new Error(`holdover write outbox /resume-alarms failed: HTTP ${String(response.status)}`);
  }
}

/** Phase 1: freeze App holdover work without purging accepted durable jobs. */
export async function prepareAppHoldoverWriteDeletion(
  inventory: HoldoverWriteAppInventoryClient,
  appId: string,
  deleteBeforeTsMs: number,
): Promise<void> {
  requireAppDeletionArgs(appId, deleteBeforeTsMs, "prepareAppHoldoverWriteDeletion");
  await inventory.beginDeletion(appId, deleteBeforeTsMs);
}

/**
 * Phase 3: after successful D1 cascade, drain/purge every registered Entity
 * outbox and mark App deletion complete. Idempotent for public retry.
 */
export async function finalizeAppHoldoverWriteDeletion(
  inventory: HoldoverWriteAppInventoryClient,
  outbox: HoldoverWriteOutboxNamespace,
  appId: string,
  deleteBeforeTsMs?: number,
): Promise<void> {
  if (appId.length === 0) {
    throw new Error("finalizeAppHoldoverWriteDeletion: appId is required");
  }
  const status = await inventory.status(appId);
  if (status.deletionComplete) {
    return;
  }
  const cutoff =
    deleteBeforeTsMs ?? (status.deleteBeforeTsMs !== null ? status.deleteBeforeTsMs : Number.NaN);
  if (!Number.isFinite(cutoff)) {
    throw new Error("finalizeAppHoldoverWriteDeletion: deleteBeforeTsMs is required");
  }
  if (!status.suppressed) {
    await inventory.beginDeletion(appId, cutoff);
  }
  await drainRegisteredEntities(inventory, outbox, appId, cutoff);
  await inventory.completeDeletion(appId);
}

/**
 * Cancel/restore after prepare when a later pre-delete step fails: clear App
 * suppress so a live App resumes ownership; wake frozen Entity alarms.
 */
export async function cancelAppHoldoverWriteDeletion(
  inventory: HoldoverWriteAppInventoryClient,
  outbox: HoldoverWriteOutboxNamespace,
  appId: string,
): Promise<void> {
  if (appId.length === 0) {
    throw new Error("cancelAppHoldoverWriteDeletion: appId is required");
  }
  const cancelled = await inventory.cancelDeletion(appId);
  if (!cancelled.cancelled) {
    return;
  }
  for (const entity of cancelled.entities) {
    await resumeEntityHoldoverWriteOutboxAlarms(outbox, {
      appId,
      idType: entity.idType,
      targetingKeyHash: entity.targetingKeyHash,
    });
  }
}

async function drainRegisteredEntities(
  inventory: HoldoverWriteAppInventoryClient,
  outbox: HoldoverWriteOutboxNamespace,
  appId: string,
  deleteBeforeTsMs: number,
): Promise<void> {
  const status = await inventory.status(appId);
  for (const entity of status.entities) {
    await suppressAndPurgeEntityHoldoverWriteOutbox(outbox, {
      appId,
      idType: entity.idType,
      targetingKeyHash: entity.targetingKeyHash,
      deleteBeforeTsMs,
    });
    await inventory.markEntityPurged(appId, entity);
  }
  const remainder = await inventory.status(appId);
  for (const entity of remainder.entities) {
    await suppressAndPurgeEntityHoldoverWriteOutbox(outbox, {
      appId,
      idType: entity.idType,
      targetingKeyHash: entity.targetingKeyHash,
      deleteBeforeTsMs,
    });
    await inventory.markEntityPurged(appId, entity);
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

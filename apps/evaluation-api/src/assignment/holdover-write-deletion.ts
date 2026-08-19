/**
 * Privacy deletion consumer for the holdover-write outbox (SPL-346).
 *
 * App deletion: begin strongly consistent App inventory suppression (also
 * writes the KV hot-path tombstone), purge every registered Entity outbox
 * (pending / completed-empty / poisoned — including never-KV rows), mark each
 * purged, then mark deletion complete before Control Plane continues to D1.
 * Public retry resumes from inventory state.
 *
 * Entity deletion: cutoff-aware suppress + drain + purge on that Entity's
 * outbox DO so stale work cannot finish after the handshake returns, while
 * post-`delete_before_ts` ensures remain allowed. The DO runs under
 * `blockConcurrencyWhile`, so an in-flight Assignment Store writer call is
 * serialized before purge complete.
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

/** Immediate App deletion action: stop every pending/alarm put for this App. */
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
 * stale put (DO concurrency), then purge stale job rows / hashes.
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
    body: JSON.stringify({ deleteBeforeTsMs: deletion.deleteBeforeTsMs }),
  });
  if (!response.ok) {
    throw new Error(`holdover write outbox /delete failed: HTTP ${String(response.status)}`);
  }
}

/**
 * App deletion coordinator: suppress via inventory (+ KV), purge every
 * registered Entity outbox, mark complete. Idempotent for public retry.
 */
export async function runAppHoldoverWriteDeletion(
  inventory: HoldoverWriteAppInventoryClient,
  outbox: HoldoverWriteOutboxNamespace,
  appId: string,
  deleteBeforeTsMs: number,
): Promise<void> {
  if (appId.length === 0) {
    throw new Error("runAppHoldoverWriteDeletion: appId is required");
  }
  if (!Number.isFinite(deleteBeforeTsMs)) {
    throw new Error("runAppHoldoverWriteDeletion: deleteBeforeTsMs is required");
  }

  const begun = await inventory.beginDeletion(appId, deleteBeforeTsMs);
  if (begun.deletionComplete) {
    return;
  }

  for (const entity of begun.entities) {
    await suppressAndPurgeEntityHoldoverWriteOutbox(outbox, {
      appId,
      idType: entity.idType,
      targetingKeyHash: entity.targetingKeyHash,
      deleteBeforeTsMs: begun.deleteBeforeTsMs,
    });
    await inventory.markEntityPurged(appId, entity);
  }

  // Resume path: inventory may still list entities registered after a prior
  // partial failure; re-read status and drain any remainder before complete.
  const status = await inventory.status(appId);
  for (const entity of status.entities) {
    await suppressAndPurgeEntityHoldoverWriteOutbox(outbox, {
      appId,
      idType: entity.idType,
      targetingKeyHash: entity.targetingKeyHash,
      deleteBeforeTsMs: begun.deleteBeforeTsMs,
    });
    await inventory.markEntityPurged(appId, entity);
  }

  await inventory.completeDeletion(appId);
}

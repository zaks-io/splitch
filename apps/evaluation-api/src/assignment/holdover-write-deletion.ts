/**
 * Privacy deletion consumer for the holdover-write outbox (SPL-346).
 *
 * App deletion: write the App suppress tombstone first so pending alarms cannot
 * recreate Assignment Store state during destructive cleanup, then purge every
 * Entity outbox whose Assignment Store KV blob is still present.
 *
 * Entity deletion: cutoff-aware suppress + drain + purge on that Entity's
 * outbox DO so stale work cannot finish after the handshake returns, while
 * post-`delete_before_ts` ensures remain allowed.
 *
 * @module
 */

import type { AssignmentKv } from "./assignment-store";
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
 * After App suppress + destructive cascade: purge each Entity outbox that still
 * has an Assignment Store KV blob so pending jobs / hashes cannot linger or
 * recreate Assignment Store state after delete completes.
 */
export async function purgeAppHoldoverWriteOutboxes(
  kv: AssignmentKv & {
    list(options: { prefix: string }): Promise<{ keys: { name: string }[] }>;
  },
  namespace: HoldoverWriteOutboxNamespace,
  appId: string,
  deleteBeforeTsMs: number,
): Promise<void> {
  const prefix = `assignment:${appId}:`;
  const listed = await kv.list({ prefix });
  for (const { name } of listed.keys) {
    const identity = parseAssignmentKvKey(name, appId);
    if (identity === null) continue;
    await suppressAndPurgeEntityHoldoverWriteOutbox(namespace, {
      ...identity,
      deleteBeforeTsMs,
    });
  }
}

function parseAssignmentKvKey(key: string, appId: string): HoldoverWriteEntityIdentity | null {
  const prefix = `assignment:${appId}:`;
  if (!key.startsWith(prefix)) return null;
  const rest = key.slice(prefix.length);
  const sep = rest.indexOf(":");
  if (sep <= 0 || sep === rest.length - 1) return null;
  return {
    appId,
    idType: rest.slice(0, sep),
    targetingKeyHash: rest.slice(sep + 1),
  };
}

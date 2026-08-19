/**
 * Privacy deletion consumer for the holdover-write outbox (SPL-346).
 *
 * App deletion: suppress tombstone first so any pending alarm cannot recreate
 * Assignment Store state, then purge each Entity outbox DO when Assignment Store
 * entities are purged (same naming as the writer).
 *
 * Entity deletion: suppress then purge that Entity's outbox DO.
 *
 * @module
 */

import type { AssignmentKv } from "./assignment-store";
import type { HoldoverWriteOutboxNamespace } from "./holdover-write-outbox";
import { appHoldoverWriteSuppressKey, holdoverWriteOutboxName } from "./holdover-write-outbox-core";

export type HoldoverWriteEntityIdentity = {
  readonly appId: string;
  readonly idType: string;
  readonly targetingKeyHash: string;
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
 * Entity deletion / App physical purge for one Entity slot: cancel pending
 * work, then purge pending/poisoned job rows so hashes do not linger. The
 * Entity suppress flag remains so a post-deletion retry cannot recreate state.
 */
export async function suppressAndPurgeEntityHoldoverWriteOutbox(
  namespace: HoldoverWriteOutboxNamespace,
  identity: HoldoverWriteEntityIdentity,
): Promise<void> {
  const name = holdoverWriteOutboxName(identity);
  const stub = namespace.get(namespace.idFromName(name));
  for (const path of ["/suppress", "/purge"] as const) {
    const response = await stub.fetch(`https://holdover-write-outbox.local${path}`, {
      method: "POST",
    });
    if (!response.ok) {
      throw new Error(`holdover write outbox ${path} failed: HTTP ${String(response.status)}`);
    }
  }
}

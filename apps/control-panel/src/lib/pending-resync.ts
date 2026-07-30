import type { ResyncRemedy } from "./resync-remedy";

const PENDING_RESYNC_KEY_PREFIX = "pending-resync:";
/** Long enough to act on, short enough not to linger as stale state forever. */
const PENDING_RESYNC_TTL_SECONDS = 60 * 60;

export type PendingResync =
  | { resource: "organization"; slug: string; reason: string; remedy: ResyncRemedy }
  | { resource: "app"; orgId: string; slug: string; reason: string; remedy: ResyncRemedy };

/**
 * Records a resync failure after a successful create (SPL-203) OUTSIDE the
 * session object on purpose.
 *
 * `StoredSession` doubles as `LiveUpdateSessionSchema` in `@splitch/contracts`
 * (`session-live-update-contract.test.ts`): a `.strict()` schema the
 * config-store Durable Object checks on every live-update socket. A field
 * added to the session and not modelled there does not degrade the socket, it
 * refuses every session, for every User, with no signal past "not authorized"
 * — `orgsTruncated` broke this on the first try. This marker never touches
 * that path, so surfacing it durably across a reload cannot repeat that
 * failure mode.
 */
export async function markPendingResync(
  kv: KVNamespace,
  tokenHash: string,
  pending: PendingResync,
): Promise<void> {
  await kv.put(pendingResyncKey(tokenHash), JSON.stringify(pending), {
    expirationTtl: PENDING_RESYNC_TTL_SECONDS,
  });
}

/** Null both when nothing is pending and when the stored value is unreadable — a corrupt marker is not worth failing the page load over. */
export async function readPendingResync(
  kv: KVNamespace,
  tokenHash: string,
): Promise<PendingResync | null> {
  const raw = await kv.get(pendingResyncKey(tokenHash), "text");
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PendingResync;
  } catch {
    return null;
  }
}

/** Called after a resync that succeeds: whatever was stale is now current. */
export async function clearPendingResync(kv: KVNamespace, tokenHash: string): Promise<void> {
  await kv.delete(pendingResyncKey(tokenHash));
}

function pendingResyncKey(tokenHash: string): string {
  return `${PENDING_RESYNC_KEY_PREFIX}${tokenHash}`;
}

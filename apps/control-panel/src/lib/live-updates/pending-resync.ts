import type { ResyncRemedy } from "#lib/live-updates/resync-remedy";

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
 *
 * Keyed by resource, not just `tokenHash`: an App create and an Organization
 * create failing to resync in the same session used to share one slot, so the
 * second write silently destroyed the first's durable signal (SPL-203 review
 * round 2). One User can have at most one pending App and one pending
 * Organization at a time, and now both survive together.
 */
export async function markPendingResync(
  kv: KVNamespace,
  tokenHash: string,
  pending: PendingResync,
): Promise<void> {
  await kv.put(pendingResyncKey(tokenHash, pending.resource), JSON.stringify(pending), {
    expirationTtl: PENDING_RESYNC_TTL_SECONDS,
  });
}

/**
 * Never lets a durability write turn a successful create into a reported
 * failure (SPL-203 review round 2, Blocker 1). `markPendingResync`'s failure
 * mode is correlated with the resync failure it is recording — both hit
 * `SESSION_STORE` — so an unguarded call here would resurrect the exact bug
 * the marker exists to fix. Losing the durable marker means the notice will
 * not survive a reload, which is strictly better than lying about the create.
 *
 * The fallback is deliberate; the silence is not (ADR-0036). If this starts
 * failing for every create, the durability half of SPL-203 is quietly gone
 * and nothing else says so — `console.warn` is the closest local convention
 * (`live-updates.ts`).
 */
export async function markPendingResyncBestEffort(
  kv: KVNamespace,
  tokenHash: string,
  pending: PendingResync,
): Promise<void> {
  try {
    await markPendingResync(kv, tokenHash, pending);
  } catch (cause) {
    console.warn(
      `Failed to record pending resync marker for ${pending.resource} "${pending.slug}"`,
      cause,
    );
  }
}

/**
 * Scoped to one resource type so an App marker and an Organization marker
 * never collide. Null both when nothing is pending and when the stored value
 * is unreadable — a corrupt marker is not worth failing the page load over.
 */
export async function readPendingResync<R extends PendingResync["resource"]>(
  kv: KVNamespace,
  tokenHash: string,
  resource: R,
): Promise<Extract<PendingResync, { resource: R }> | null> {
  const raw = await kv.get(pendingResyncKey(tokenHash, resource), "text");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PendingResync;
    return parsed.resource === resource
      ? (parsed as Extract<PendingResync, { resource: R }>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Called after a resync that succeeds: whatever was stale is now current.
 * Clears both resource slots — a successful resync rebuilds the whole
 * principal from D1, so it resolves an App marker and an Organization marker
 * at the same time, not just whichever one triggered this call.
 */
export async function clearPendingResync(kv: KVNamespace, tokenHash: string): Promise<void> {
  await Promise.all([
    kv.delete(pendingResyncKey(tokenHash, "app")),
    kv.delete(pendingResyncKey(tokenHash, "organization")),
  ]);
}

function pendingResyncKey(tokenHash: string, resource: PendingResync["resource"]): string {
  return `${PENDING_RESYNC_KEY_PREFIX}${resource}:${tokenHash}`;
}

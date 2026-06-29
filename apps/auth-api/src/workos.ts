/**
 * WorkOS user-store port.
 *
 * Door A resolves a WorkOS user by verified email, creating one on first sight
 * (auth-doors.md step 8). An agent is never a distinct principal — it resolves to
 * a real, persistent WorkOS user. splitch D1 stores membership references only,
 * so this port returns the opaque `user_id` and nothing PII lands in D1.
 *
 * LOCAL FIXTURE: there is no real IdP locally, so the fixture implementation
 * keeps an in-memory email -> user_id map and mints deterministic ids. The real
 * implementation (a WorkOS SDK call) swaps in behind this same port without
 * touching the door logic — the deletion test passes (door logic depends on the
 * interface, fixture and real are two adapters).
 */

export interface WorkOsPort {
  /** Resolve a user_id for a verified email, creating the user if first-seen. */
  resolveOrCreateUser(email: string): Promise<string>;
}

/** Stable, opaque user id from an email (deterministic so re-auth returns the same id). */
function fixtureUserId(email: string): string {
  const slug = email.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return `user_fixture_${slug}`;
}

/** The local fixture WorkOS store. First-seen emails create a deterministic user. */
export function makeFixtureWorkOs(): WorkOsPort {
  const known = new Set<string>();
  return {
    async resolveOrCreateUser(email) {
      const id = fixtureUserId(email);
      known.add(id);
      return id;
    },
  };
}

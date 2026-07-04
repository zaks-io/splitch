import { normalizeEmail } from "./email";

/**
 * WorkOS user-store port.
 *
 * Door A resolves a WorkOS user by verified email, creating one on first sight
 * (auth-doors.md step 8). Door B (anonymous register) instead mints a user with
 * NO verified email yet (an unverified placeholder), and the claim ceremony later
 * binds + verifies a real email. An agent is never a distinct principal — it
 * resolves to a real, persistent WorkOS user. splitch D1 stores membership
 * references only, so this port returns the opaque `user_id` and nothing PII
 * lands in D1.
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
  /** Mint a fresh anonymous user with NO verified email yet (Door B register). */
  createProvisionalUser(): Promise<string>;
  /**
   * The user_id of an EXISTING verified user for this email, or null. Used by the
   * claim ceremony to detect a collision (account-takeover prevention): a claim
   * whose email already maps to a real user must NEVER silently merge.
   */
  findVerifiedUserByEmail(email: string): Promise<string | null>;
  /** Bind + mark an email verified on a previously-provisional user (on claim). */
  verifyEmail(userId: string, email: string): Promise<void>;
}

/** Stable, opaque user id from a canonical email (deterministic so re-auth returns the same id). */
function fixtureUserId(canonicalEmail: string): string {
  const slug = canonicalEmail.replace(/[^a-z0-9]+/g, "_");
  return `user_fixture_${slug}`;
}

/** The local fixture WorkOS store. First-seen emails create a deterministic user. */
export function makeFixtureWorkOs(): WorkOsPort {
  // canonical email -> user_id for VERIFIED emails only. The index keys on the
  // SAME normalizeEmail() canonical form the claim collision check uses, so a
  // Unicode/punycode (or case) variant of one mailbox can never miss the lookup
  // and slip past the takeover check (Finding 2). A provisional user is absent
  // here until its claim verifies an email, so a pre-claim collision check is clean.
  const verifiedByEmail = new Map<string, string>();
  let anonSeq = 0;

  return {
    async resolveOrCreateUser(email) {
      const canonical = normalizeEmail(email);
      const id = fixtureUserId(canonical);
      verifiedByEmail.set(canonical, id);
      return id;
    },

    async createProvisionalUser() {
      anonSeq += 1;
      return `user_anon_${anonSeq}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    },

    async findVerifiedUserByEmail(email) {
      return verifiedByEmail.get(normalizeEmail(email)) ?? null;
    },

    async verifyEmail(userId, email) {
      verifiedByEmail.set(normalizeEmail(email), userId);
    },
  };
}

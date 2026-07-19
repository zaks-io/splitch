/**
 * Session-validation hot read (access-control-matrix.md "Revocation").
 *
 * Killing a WorkOS session or revoking a control-plane token must take effect
 * before the token's own `exp`. The control-plane keeps a KV revocation marker
 * keyed by the token's session id; a present marker means the session was
 * revoked. Verifying signature/exp alone is not enough — a still-unexpired token
 * for a revoked session must be rejected.
 *
 * Fail-loud: a present marker → revoked (reject). Absent (`null`) → still valid.
 * A KV binding that THROWS is a genuine fault that propagates (the guard maps it
 * to 500); it is never swallowed into a silent allow.
 */

const REVOKED_PREFIX = "revoked:";

export interface SessionStore {
  /** True iff the session/token was revoked. Throws on a KV fault (never silent). */
  isRevoked(sessionId: string): Promise<boolean>;
}

export function makeSessionStore(kv: KVNamespace): SessionStore {
  return {
    async isRevoked(sessionId) {
      const marker = await kv.get(`${REVOKED_PREFIX}${sessionId}`);
      return marker !== null;
    },
  };
}

/** Build a revocation key for writers/tests (single authoring point for the shape). */
export function revocationKey(sessionId: string): string {
  return `${REVOKED_PREFIX}${sessionId}`;
}

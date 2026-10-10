import { accessTokenRevocationKey, readAccessTokenRevocation } from "@splitch/contracts";

/**
 * Session-validation hot read (access-control-matrix.md "Revocation").
 *
 * Killing a WorkOS session or revoking a control-plane token must take effect
 * before the token's own `exp`. The control-plane keeps a KV revocation marker
 * keyed by the token's session id; a present marker means the session was
 * revoked. Verifying signature/exp alone is not enough — a still-unexpired token
 * for a revoked session must be rejected.
 *
 * Fail-loud: a marker revokes tokens issued at or before its revocation time;
 * tokens issued later (a fresh login) stay valid. Absent (`null`) → still valid.
 * A KV binding that THROWS is a genuine fault that propagates (the guard maps it
 * to 500); it is never swallowed into a silent allow.
 */

export interface SessionStore {
  /** True iff the token was revoked. Throws on a KV fault (never silent). */
  isRevoked(sessionId: string, issuedAtSeconds: number | undefined): Promise<boolean>;
}

export function makeSessionStore(kv: KVNamespace): SessionStore {
  return {
    async isRevoked(sessionId, issuedAtSeconds) {
      return readAccessTokenRevocation(kv, sessionId, issuedAtSeconds);
    },
  };
}

/** Build a revocation key for writers/tests (single authoring point for the shape). */
export function revocationKey(sessionId: string): string {
  return accessTokenRevocationKey(sessionId);
}

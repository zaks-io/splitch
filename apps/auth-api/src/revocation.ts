/**
 * Control-plane token revocation markers.
 *
 * The auth-api writes the same `revoked:{sub}` marker shape the control-plane
 * session store reads. That keeps `/oauth2/revoke` and protected-route auth on
 * one contract without importing across Worker app boundaries.
 */

const REVOKED_PREFIX = "revoked:";
const MIN_KV_EXPIRATION_TTL_SECONDS = 60;

export interface RevocationStore {
  revoke(subject: string, ttlSeconds: number): Promise<void>;
  isRevoked(subject: string): Promise<boolean>;
}

function revocationKey(subject: string): string {
  return `${REVOKED_PREFIX}${subject}`;
}

export function makeKvRevocationStore(kv: KVNamespace): RevocationStore {
  return {
    async revoke(subject, ttlSeconds) {
      const expirationTtl = Math.max(MIN_KV_EXPIRATION_TTL_SECONDS, Math.ceil(ttlSeconds));
      await kv.put(revocationKey(subject), "1", { expirationTtl });
    },

    async isRevoked(subject) {
      return (await kv.get(revocationKey(subject))) !== null;
    },
  };
}

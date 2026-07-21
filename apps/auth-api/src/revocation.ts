/**
 * Control-plane token revocation markers.
 *
 * The auth-api writes the same `revoked:{sub}` marker shape the control-plane
 * and MCP boundaries read. That keeps `/oauth2/revoke` and protected-route auth
 * on one contract without importing across Worker app boundaries.
 */

import { accessTokenRevocationKey, accessTokenRevocationTtl } from "@splitch/contracts";

export interface RevocationStore {
  revoke(subject: string, ttlSeconds: number): Promise<void>;
  isRevoked(subject: string): Promise<boolean>;
}

export function makeKvRevocationStore(kv: KVNamespace): RevocationStore {
  return {
    async revoke(subject, ttlSeconds) {
      await kv.put(accessTokenRevocationKey(subject), "1", {
        expirationTtl: accessTokenRevocationTtl(ttlSeconds),
      });
    },

    async isRevoked(subject) {
      return (await kv.get(accessTokenRevocationKey(subject))) !== null;
    },
  };
}

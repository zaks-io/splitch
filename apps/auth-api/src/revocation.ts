/**
 * Control-plane token revocation markers.
 *
 * The auth-api writes the same `revoked:{sub}` marker shape the control-plane
 * and MCP boundaries read. That keeps `/oauth2/revoke` and protected-route auth
 * on one contract without importing across Worker app boundaries.
 */

import {
  accessTokenRevocationKey,
  accessTokenRevocationMarker,
  accessTokenRevocationTtl,
  readAccessTokenRevocation,
} from "@splitch/contracts";

export interface RevocationStore {
  revoke(subject: string, revokedAtSeconds: number, ttlSeconds: number): Promise<void>;
  isRevoked(subject: string, issuedAtSeconds: number | undefined): Promise<boolean>;
}

export function makeKvRevocationStore(kv: KVNamespace): RevocationStore {
  return {
    async revoke(subject, revokedAtSeconds, ttlSeconds) {
      await kv.put(
        accessTokenRevocationKey(subject),
        accessTokenRevocationMarker(revokedAtSeconds),
        {
          expirationTtl: accessTokenRevocationTtl(ttlSeconds),
        },
      );
    },

    async isRevoked(subject, issuedAtSeconds) {
      return readAccessTokenRevocation(kv, subject, issuedAtSeconds);
    },
  };
}

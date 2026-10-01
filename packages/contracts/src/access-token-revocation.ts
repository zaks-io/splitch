import { z } from "zod";

const REVOKED_PREFIX = "revoked:";
const MIN_KV_EXPIRATION_TTL_SECONDS = 60;
// Markers written before the revocation time was recorded revoke every token until their TTL lapses.
const LEGACY_REVOKE_ALL_MARKER = "1";

const AccessTokenRevocationMarkerSchema = z.string().regex(/^[1-9]\d*$/u);

interface AccessTokenRevocationSource {
  get(key: string): Promise<string | null>;
}

export function accessTokenRevocationKey(subject: string): string {
  return `${REVOKED_PREFIX}${subject}`;
}

export function accessTokenRevocationTtl(ttlSeconds: number): number {
  return Math.max(MIN_KV_EXPIRATION_TTL_SECONDS, Math.ceil(ttlSeconds));
}

export function accessTokenRevocationMarker(revokedAtSeconds: number): string {
  if (!Number.isSafeInteger(revokedAtSeconds) || revokedAtSeconds <= 1) {
    throw new Error(`access-token revocation time is invalid: ${revokedAtSeconds}`);
  }
  return String(revokedAtSeconds);
}

/** The verified token's `iat`, carried so revocation can tell a fresh login from a revoked token. */
export function accessTokenIssuedAt(claims: Record<string, unknown>): { issuedAt?: number } {
  return typeof claims.iat === "number" ? { issuedAt: claims.iat } : {};
}

/**
 * A marker revokes only the tokens issued at or before it, so signing in again
 * after a logout works immediately. A token without `iat` cannot prove it was
 * issued later and stays revoked. AuthKit tokens carry WorkOS's clock, so a
 * refresh in the same second as the logout (or inside clock skew) stays revoked.
 */
export function isAccessTokenRevoked(
  marker: string | null,
  issuedAtSeconds: number | undefined,
): boolean {
  if (marker === null) return false;
  const parsed = AccessTokenRevocationMarkerSchema.safeParse(marker);
  if (!parsed.success) {
    throw new Error(`access-token revocation marker is malformed: ${marker}`);
  }
  if (parsed.data === LEGACY_REVOKE_ALL_MARKER || issuedAtSeconds === undefined) return true;
  return issuedAtSeconds <= Number(parsed.data);
}

export async function readAccessTokenRevocation(
  source: AccessTokenRevocationSource,
  subject: string,
  issuedAtSeconds: number | undefined,
): Promise<boolean> {
  return isAccessTokenRevoked(await source.get(accessTokenRevocationKey(subject)), issuedAtSeconds);
}

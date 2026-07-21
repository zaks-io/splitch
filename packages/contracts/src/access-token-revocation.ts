const REVOKED_PREFIX = "revoked:";
const MIN_KV_EXPIRATION_TTL_SECONDS = 60;

export function accessTokenRevocationKey(subject: string): string {
  return `${REVOKED_PREFIX}${subject}`;
}

export function accessTokenRevocationTtl(ttlSeconds: number): number {
  return Math.max(MIN_KV_EXPIRATION_TTL_SECONDS, Math.ceil(ttlSeconds));
}

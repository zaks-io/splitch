import { OAuthError } from "./oauth-errors";

/**
 * jti replay cache (auth-doors.md step 7).
 *
 * WHY: an ID-JAG is a one-time bearer assertion. Replaying a still-valid token
 * must be rejected even though its signature/claims are all valid. The cache key
 * is `jti:{jti}` in the auth-api's own KV namespace, with TTL = `exp - now` so the
 * entry lives exactly as long as the token could be replayed and then self-evicts.
 *
 * The check-then-mark is fail-loud: a seen jti throws `replayed_jti`; an unseen
 * jti is recorded before the user is resolved.
 *
 * KNOWN LIMITATION — TOCTOU replay window: this is a get-then-put, NOT an atomic
 * check-and-set. Two presentations of the SAME jti that race within the single
 * KV round-trip can both read "absent" and both proceed; the loser's put merely
 * overwrites. The window is one round-trip and the practical exposure is small,
 * but it is real and accepted for now. True one-time semantics need an atomic
 * unique-insert (a Durable Object keyed by jti, or a D1 `INSERT ... jti PRIMARY
 * KEY` that fails the second writer). Deferred — sequential replay (the common
 * case) is fully closed; concurrent same-jti replay is the residual gap.
 */

const JTI_PREFIX = "jti:";

/** Minimum TTL KV will accept; a token already near expiry still gets recorded. */
const MIN_TTL_SECONDS = 60;

export interface JtiCache {
  /** Reject if the jti was already seen; otherwise record it with the token's TTL. */
  assertFreshAndRecord(jti: string, expUnixSeconds: number, nowUnixSeconds: number): Promise<void>;
}

export function makeJtiCache(kv: KVNamespace): JtiCache {
  return {
    async assertFreshAndRecord(jti, expUnixSeconds, nowUnixSeconds) {
      if (!jti) {
        throw new OAuthError("invalid_token", "ID-JAG is missing the jti claim");
      }
      const key = `${JTI_PREFIX}${jti}`;
      const seen = await kv.get(key);
      if (seen !== null) {
        throw new OAuthError("replayed_jti", "ID-JAG jti has already been used");
      }
      const ttl = Math.max(MIN_TTL_SECONDS, expUnixSeconds - nowUnixSeconds);
      await kv.put(key, "1", { expirationTtl: ttl });
    },
  };
}

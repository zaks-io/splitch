import { OAuthError } from "./oauth-errors";

/**
 * Claim-ceremony OTP + idempotency-key dedup (auth-doors.md claim step 2). Both
 * are FIXTURES locally (no real OTP delivery, no real D1 OTP table — that schema
 * is wave 2). The shapes here are the ports the real adapters slot behind.
 *
 * OTP — the takeover defense. The code is BOUND TO THE CLAIMED EMAIL and is
 * ISSUED AT CLAIM-INITIATION (sent to that email), NOT at register time. A
 * provisional user has no email at register, so an OTP issued then could only
 * prove "holder knows user X's code", never "holder controls email Y" — exactly
 * the pre-emptive-takeover hole. Binding the code to (userId, email) and requiring
 * it to have been delivered to that email proves possession of the claimed address.
 *
 * Brute-force guard (H3): a 6-digit code has ~10^6 guesses. Each live code carries
 * an attempt counter; after MAX_ATTEMPTS wrong guesses the code is BURNED (lockout)
 * and a fresh initiate is required. The port carries this so the real adapter must
 * implement the same cap.
 *
 * Idempotency — `reserve` is ATOMIC (insert-if-absent): the FIRST claim for a key
 * wins and may mutate; a concurrent/later claim with the same key LOSES and
 * replays the stored result, never double-claiming. The fixture is per-isolate;
 * the real adapter MUST be a shared atomic store (D1 `INSERT … ON CONFLICT DO
 * NOTHING` / a KV/DO conditional put).
 */

const OTP_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;

export interface OtpVerifier {
  /** Issue + "deliver" a code to `email` for `userId`, anchoring its 10m TTL. */
  issue(userId: string, email: string, nowMs: number): void;
  /**
   * Throw `invalid_grant` unless `otp` is the live (≤10m, under the attempt cap)
   * code issued for THIS (userId, email) pair. A wrong guess increments the
   * counter; exceeding MAX_ATTEMPTS burns the code (lockout, fail-loud).
   */
  assertValid(userId: string, email: string, otp: string, nowMs: number): void;
}

/** The fixture's well-known OTP, "delivered" to the claimed email on initiate. */
export const FIXTURE_OTP = "000000";

/** Key an OTP record on the (userId, canonical email) pair so it can't cross-bind. */
function otpKey(userId: string, email: string): string {
  return `${userId} ${email}`;
}

interface OtpRecord {
  issuedAt: number;
  attempts: number;
}

/**
 * Fixture OTP verifier. `issue` records a live code for (userId, email); a claim
 * with NO prior initiate for that exact pair has no live code and is rejected —
 * this blocks claiming an email the caller never had a code delivered to.
 */
export function makeFixtureOtp(): OtpVerifier {
  const records = new Map<string, OtpRecord>();
  return {
    issue(userId, email, nowMs) {
      records.set(otpKey(userId, email), { issuedAt: nowMs, attempts: 0 });
    },
    assertValid(userId, email, otp, nowMs) {
      const key = otpKey(userId, email);
      const record = records.get(key);
      if (!record || nowMs - record.issuedAt > OTP_TTL_MS) {
        throw new OAuthError("invalid_grant", "no live OTP for this email (expired or never sent)");
      }
      if (record.attempts >= MAX_ATTEMPTS) {
        records.delete(key);
        throw new OAuthError("invalid_grant", "OTP attempt limit reached; request a new code");
      }
      if (otp !== FIXTURE_OTP) {
        record.attempts += 1;
        throw new OAuthError("invalid_grant", "OTP is incorrect");
      }
    },
  };
}

/** A completed claim's result, replayed verbatim for a same-key retry. */
interface ClaimRecord {
  userId: string;
  orgId: string;
  appId: string;
}

export interface IdempotencyStore {
  /**
   * Atomically reserve `key`. `won: true` → this caller is FIRST (may mutate);
   * `won: false` → a prior holder owns it, with the stored `record` (prior claim
   * finished) or `record: null` (prior still in-flight).
   */
  reserve(key: string): { won: true } | { won: false; record: ClaimRecord | null };
  /** Record the completed claim's result, releasing the in-flight reservation. */
  complete(key: string, record: ClaimRecord): void;
  /**
   * Release an in-flight reservation WITHOUT completing it, so a later retry can
   * re-reserve and re-run the ceremony. The winner calls this when its ceremony
   * FAILS (wrong OTP, expired assertion, collision, 0-row clear) — a failed claim
   * must not lock the key forever (Finding 3). It only clears the in-flight marker;
   * a key that already holds a completed record is left untouched, so releasing a
   * loser's failure can never erase the winner's stored result.
   */
  release(key: string): void;
}

/**
 * In-memory idempotency store (fixture). PER-ISOLATE — enough to prove the
 * reserve-before-mutate contract in tests, NOT a real cross-request lock; the
 * production adapter must be a shared atomic store (D1/KV/DO).
 */
export function makeIdempotencyStore(): IdempotencyStore {
  const byKey = new Map<string, ClaimRecord | null>();
  return {
    reserve(key) {
      if (byKey.has(key)) {
        return { won: false, record: byKey.get(key) ?? null };
      }
      byKey.set(key, null); // reserved, in-flight (no result yet)
      return { won: true };
    },
    complete(key, record) {
      byKey.set(key, record);
    },
    release(key) {
      // Only drop a still-in-flight reservation. If a completed record is present
      // (another caller already finished), leave it — never erase a real result.
      if (byKey.get(key) === null) {
        byKey.delete(key);
      }
    },
  };
}

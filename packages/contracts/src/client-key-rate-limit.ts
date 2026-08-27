import { z } from "zod";

/**
 * Cloudflare Rate Limit bindings only accept a 10s or 60s window. 3000 tokens
 * per 10s is a 300 rps 1-token ceiling so the ADR-0034 100 rps default and
 * integer overrides that divide 300 (including 30) debit an integer token
 * count and are enforced exactly.
 */
export const DEFAULT_CLIENT_KEY_RATE_LIMIT_RPS = 100;
export const CLIENT_KEY_RATE_LIMIT_WINDOW_SECONDS = 10;
export const CLIENT_KEY_RATE_LIMIT_WINDOW_TOKENS = 3000;
export const CLIENT_KEY_RATE_LIMIT_WINDOW_RPS =
  CLIENT_KEY_RATE_LIMIT_WINDOW_TOKENS / CLIENT_KEY_RATE_LIMIT_WINDOW_SECONDS;

export const CLIENT_KEY_RATE_LIMIT_RPS_MESSAGE =
  "rateLimitRps must be a positive integer the Cloudflare limiter can enforce exactly";

export function isExactClientKeyRateLimitRps(rateLimitRps: number): boolean {
  return (
    Number.isInteger(rateLimitRps) &&
    rateLimitRps > 0 &&
    rateLimitRps <= DEFAULT_CLIENT_KEY_RATE_LIMIT_RPS &&
    CLIENT_KEY_RATE_LIMIT_WINDOW_RPS % rateLimitRps === 0
  );
}

/** Exact PATCH/write set: 300 % rps === 0 and rps <= 100. */
export const EXACT_CLIENT_KEY_RATE_LIMIT_RPS = [
  1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 25, 30, 50, 60, 75, 100,
] as const;

/** Shared wire/storage write validator: accepted positive integers only, never quantized. */
export const StoredClientKeyRateLimitRpsSchema = z
  .number()
  .int()
  .positive()
  .refine(isExactClientKeyRateLimitRps, { message: CLIENT_KEY_RATE_LIMIT_RPS_MESSAGE });

export const StoredClientKeyRateLimitRpsFieldSchema =
  StoredClientKeyRateLimitRpsSchema.nullable().optional();

/**
 * Read-side cache field. Main previously persisted any numeric override (including
 * 80). Those blobs must parse so Evaluation can fail closed as RATE_LIMITED.
 */
export const CachedClientKeyRateLimitRpsFieldSchema = z.number().nullable().optional();

/**
 * Resolve a stored Client Key `rateLimitRps` to the enforced per-second cap.
 * `null` / omitted means the ADR default. Values the Cloudflare binding cannot
 * enforce exactly fail loud so a corrupt cache cannot silently loosen the cap.
 */
export function resolveClientKeyRateLimitRps(rateLimitRps: number | null | undefined): number {
  if (rateLimitRps === null || rateLimitRps === undefined) {
    return DEFAULT_CLIENT_KEY_RATE_LIMIT_RPS;
  }
  if (!isExactClientKeyRateLimitRps(rateLimitRps)) {
    throw new Error(CLIENT_KEY_RATE_LIMIT_RPS_MESSAGE);
  }
  return rateLimitRps;
}

export function clientKeyRateLimitTokensPerRequest(rateLimitRps: number): number {
  return CLIENT_KEY_RATE_LIMIT_WINDOW_RPS / resolveClientKeyRateLimitRps(rateLimitRps);
}

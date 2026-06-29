/**
 * Deterministic, synchronous, cross-runtime bucketing hash.
 *
 * WHY FNV-1a (32-bit) and not SHA-256: `assign()` is a PURE SYNCHRONOUS function
 * called inside the evaluate loop (it returns a Variant name string, never a
 * Promise). The only cross-runtime SHA available in Workers/Durable Objects is
 * Web Crypto's `crypto.subtle.digest`, which is ASYNC — unusable from a sync
 * pure function without poisoning the whole evaluate path with promises. FNV-1a
 * is a well-distributed, trivially portable non-cryptographic hash that every
 * runtime and future SDK language can reimplement byte-for-byte from this one
 * definition, which is exactly the cross-runtime-parity property the determinism
 * contract requires (docs/spec/evaluation/assign-pure-function.md). The hash is
 * NOT a security primitive here — it only spreads keys uniformly across [0, 1).
 *
 * The reference platforms (Statsig: SHA-256 → bucket out of 10000) inform the
 * SHAPE — hash an identity string, map to a fixed-resolution bucket — not the
 * specific algorithm, which no ADR mandates. We pin FNV-1a so parity is a
 * property of this file alone.
 *
 * WHY the extra finalizer mix: raw FNV-1a has weak avalanche, so CONTIGUOUS
 * low-entropy keys — autoincrement integer user IDs, a very common targetingKey
 * — produce a near-linear ramp of bucket points (measured lag-1 autocorrelation
 * ~0.88, same-variant runs of 50-100 over sequential keys). A small or medium
 * sequential cohort then deviates badly from its configured split (a 1000-id
 * 50/50 cohort drifts 8-12 points). Appending a standard 32-bit integer finalizer
 * (the "lowbias32" xorshift-multiply mix) decorrelates sequential inputs (lag-1
 * drops to ~0, run lengths become random) while preserving every property above:
 * still sync, still pure, still byte-reproducible in any language from these
 * fixed constants.
 */

// FNV-1a 32-bit constants (the canonical, fixed parameters of the algorithm).
const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

// lowbias32 finalizer constants (Wellons' low-bias 32-bit integer mix). Fixed,
// so any runtime reproduces the same avalanche.
const MIX_1 = 0x7feb352d;
const MIX_2 = 0x846ca68b;

// 2^32, the divisor that maps a 32-bit hash into the half-open unit interval.
const UINT32_SPACE = 0x100000000;

/**
 * The lowbias32 integer finalizer: a fixed xorshift-multiply avalanche that
 * spreads neighbouring inputs across the full 32-bit space. This is what breaks
 * the serial correlation of sequential keys.
 */
function mix32(value: number): number {
  let hash = value;
  hash ^= hash >>> 16;
  hash = Math.imul(hash, MIX_1) >>> 0;
  hash ^= hash >>> 15;
  hash = Math.imul(hash, MIX_2) >>> 0;
  hash ^= hash >>> 16;
  return hash >>> 0;
}

/**
 * FNV-1a over the UTF-8 bytes of `input`, then the lowbias32 finalizer, returned
 * as an unsigned 32-bit integer. `>>> 0` after each step keeps arithmetic in
 * unsigned-32-bit space so the result is identical regardless of how a runtime
 * represents intermediate numbers.
 */
function fnv1a32(input: string): number {
  const bytes = new TextEncoder().encode(input);
  let hash = FNV_OFFSET_BASIS;
  for (const byte of bytes) {
    hash ^= byte;
    // Math.imul gives a true 32-bit multiply; the >>> 0 normalizes to unsigned.
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return mix32(hash);
}

/**
 * Map a string to a deterministic fraction in the half-open interval [0, 1).
 * Dividing the 32-bit hash by 2^32 can never reach 1.0, so 100%-cumulative
 * boundaries always capture every key (no key falls past the last bucket).
 */
export function hashToUnitInterval(input: string): number {
  return fnv1a32(input) / UINT32_SPACE;
}

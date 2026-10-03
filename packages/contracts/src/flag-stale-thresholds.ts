import type { StoredFlagLifecycleClass } from "./leaf-schemas-flag";

/**
 * Configuration-state stale thresholds by Flag Lifecycle Class (plan 3.6).
 *
 * Ops and permission Flags are intentionally permanent (D9), so uniform-serving
 * and unchanged signals do not apply to them: a forever-on kill switch is not
 * debt. Release, experiment, and still-unclassified Flags are temporary and use
 * the thresholds below. Past-expiry is separate and keys on `expiresAt` alone.
 *
 * The uniform-serving window matches the Phase 3 proof: a Flag at 100% for 30
 * days is stale; a 50/50 Flag is not.
 */
export type FlagStaleThresholds = {
  /** Days every Environment must stay uniform before the signal fires; null = off. */
  uniformServingDays: number | null;
  /** Days since last recorded change before the signal fires; null = off. */
  unchangedDays: number | null;
};

export const FLAG_STALE_THRESHOLDS: Record<StoredFlagLifecycleClass, FlagStaleThresholds> = {
  release: { uniformServingDays: 30, unchangedDays: 90 },
  experiment: { uniformServingDays: 30, unchangedDays: 90 },
  unclassified: { uniformServingDays: 30, unchangedDays: 90 },
  ops: { uniformServingDays: null, unchangedDays: null },
  permission: { uniformServingDays: null, unchangedDays: null },
};

export const FLAG_AGE_BUCKETS = ["0_30d", "30_90d", "90_180d", "180_365d", "365d_plus"] as const;
export type FlagAgeBucket = (typeof FLAG_AGE_BUCKETS)[number];

/** Inclusive lower bound (days), exclusive upper bound; `null` upper = open. */
export const FLAG_AGE_BUCKET_BOUNDS: Record<
  FlagAgeBucket,
  { minDaysInclusive: number; maxDaysExclusive: number | null }
> = {
  "0_30d": { minDaysInclusive: 0, maxDaysExclusive: 30 },
  "30_90d": { minDaysInclusive: 30, maxDaysExclusive: 90 },
  "90_180d": { minDaysInclusive: 90, maxDaysExclusive: 180 },
  "180_365d": { minDaysInclusive: 180, maxDaysExclusive: 365 },
  "365d_plus": { minDaysInclusive: 365, maxDaysExclusive: null },
};

export function flagAgeBucket(ageDays: number): FlagAgeBucket {
  if (!Number.isFinite(ageDays) || ageDays < 0) {
    throw new Error(`flagAgeBucket: ageDays must be a non-negative finite number, got ${ageDays}`);
  }
  for (const bucket of FLAG_AGE_BUCKETS) {
    const { minDaysInclusive, maxDaysExclusive } = FLAG_AGE_BUCKET_BOUNDS[bucket];
    if (ageDays >= minDaysInclusive && (maxDaysExclusive === null || ageDays < maxDaysExclusive)) {
      return bucket;
    }
  }
  throw new Error(`flagAgeBucket: no bucket for ageDays=${ageDays}`);
}

import { PercentageRolloutSchema, type PercentageRollout } from "@splitch/contracts";
import { randomHex } from "./credential-cache";

/**
 * The baseline-rollout salt rule, in one place.
 *
 * A PercentageRollout's salt IS its bucket assignment: `fractionalEval` hashes
 * `salt + ":" + targetingKey`, so replacing the salt reshuffles which Entities
 * are inside the rollout. Regenerating it while merely changing the percentage
 * would silently move users in and out of the treatment — a change nobody asked
 * for and nobody can see, which is exactly the silent-fallback failure ADR-0036
 * forbids. So: mint once when the baseline is first established, then carry that
 * salt verbatim through every later percentage change.
 *
 * Clearing to `null` is the one way to drop a salt, and it is explicit and
 * visible. Re-establishing afterwards mints a fresh one, because the operator
 * has already accepted losing the old cohort by clearing it.
 */
export function nextBaselineRollout(
  current: PercentageRollout | null,
  patch: { percentage: number } | null | undefined,
): PercentageRollout | null | undefined {
  // Absent from the patch = leave the baseline exactly as it is.
  if (patch === undefined) return undefined;
  if (patch === null) return null;

  return PercentageRolloutSchema.parse({
    percentage: patch.percentage,
    // Reusing the existing salt is the whole point: same salt + same key = same
    // bucket, so a 10 -> 25 change only widens the band, it never reshuffles it.
    salt: current?.salt ?? mintSalt(),
  });
}

/** 16 hex chars of CSPRNG entropy — enough to keep two rollouts from colliding. */
export function mintSalt(): string {
  return randomHex(8);
}

/**
 * Parse a stored `rollout` JSON column. A malformed value is corrupt config, not
 * "no rollout", so it throws rather than degrading to null (ADR-0036).
 */
export function parseStoredRollout(value: string | null): PercentageRollout | null {
  if (value === null) return null;
  return PercentageRolloutSchema.parse(JSON.parse(value));
}

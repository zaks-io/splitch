import { type PercentageRollout, PercentageRolloutSchema } from "@splitch/contracts";
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
  freshSalt = mintSalt,
): PercentageRollout | null | undefined {
  // Absent from the patch = leave the baseline exactly as it is.
  if (patch === undefined) return undefined;
  if (patch === null) return null;

  return PercentageRolloutSchema.parse({
    percentage: patch.percentage,
    // Reusing the existing salt is the whole point: same salt + same key = same
    // bucket, so a 10 -> 25 change only widens the band, it never reshuffles it.
    salt: current?.salt ?? freshSalt(),
  });
}

/** 16 hex chars of CSPRNG entropy — enough to keep two rollouts from colliding. */
export function mintSalt(): string {
  return randomHex(8);
}

/**
 * The Variants a baseline could roll traffic INTO.
 *
 * A baseline rolls AWAY from the Default Variant, so the candidates are the
 * non-Default entries of the available set. An EMPTY available set is not a
 * narrowing to zero Variants — it is a Configuration nobody has narrowed yet
 * (SPL-164 initializes it empty), so the candidates fall back to the Flag's
 * catalog. Treating "uninitialized" as "ambiguous" would reject the baseline on
 * every freshly created Flag, which is exactly the one-call path the quickstart
 * promises.
 */
function baselineCandidates(
  availableVariantNames: string[],
  catalogVariantNames: string[],
  defaultVariantName: string | undefined,
): string[] {
  const scope = availableVariantNames.length > 0 ? availableVariantNames : catalogVariantNames;
  return scope.filter((name) => name !== defaultVariantName);
}

/**
 * Whether a Flag Configuration would be left with a baseline it cannot resolve.
 *
 * A baseline needs exactly one candidate to roll into. With two-plus the
 * destination is unknowable and evaluation throws (baseline-rollout.ts).
 *
 * This takes the RESULTING state, not the patch, because a Configuration can be
 * stranded from either side: setting a baseline under an already-wide available
 * set, or widening the available set under an already-set baseline. Checking only
 * the field the caller happened to touch misses the other half.
 */
export function baselineIsUnresolvable(
  rollout: PercentageRollout | { percentage: number } | null,
  availableVariantNames: string[],
  defaultVariantName: string | undefined,
  catalogVariantNames: string[],
): boolean {
  if (rollout === null) return false;
  return (
    baselineCandidates(availableVariantNames, catalogVariantNames, defaultVariantName).length !== 1
  );
}

/**
 * Parse a stored `rollout` JSON column. A malformed value is corrupt config, not
 * "no rollout", so it throws rather than degrading to null (ADR-0036).
 */
export function parseStoredRollout(value: string | null): PercentageRollout | null {
  if (value === null) return null;
  return PercentageRolloutSchema.parse(JSON.parse(value));
}

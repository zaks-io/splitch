import { hashToUnitInterval } from "./hash";

/**
 * An ordered, name-keyed weight set. Each share's `weight` is a percentage in
 * [0, 100] and the weights sum to 100. Keyed by Variant NAME — the one term the
 * Exposure row, the analysis denominator, and the allocation config all share,
 * so there is never an id↔name join on the hot path
 * (docs/spec/contracts/leaf-schemas-experiment.md, "allocation is keyed by name").
 *
 * Order matters: bucket boundaries are laid out by accumulating weights in array
 * order, so two callers with identical weights in identical order get identical
 * boundaries.
 */
export type Rollout = Array<{ variantName: string; weight: number }>;

/**
 * fractionalEval — the OpenFeature Fractional Evaluation primitive.
 *
 * The hash input is ALWAYS `salt + ":" + targetingKey`. There is NO other
 * hashable parameter: `rollout` only shapes the bucket boundaries, it is never
 * fed into the hash. Hashing on anything but the Targeting Key is therefore
 * structurally impossible, not merely discouraged
 * (docs/spec/evaluation/assign-pure-function.md, determinism contract §3).
 *
 * Pure and deterministic: same `(salt, targetingKey, rollout)` always yields the
 * same Variant name. Assumes valid input (weights sum to 100, validated at the
 * write boundary) and never returns an error.
 */
export function fractionalEval(salt: string, targetingKey: string, rollout: Rollout): string {
  // The single, fixed hash identity. No branch can substitute another value.
  const point = hashToUnitInterval(`${salt}:${targetingKey}`) * 100;

  let cumulative = 0;
  // `lastName` carries the final share forward so a `point` left a hair above the
  // last boundary by floating-point summation still resolves to a Variant —
  // without an index-access-after-loop that the type checker can't prove is safe.
  let lastName = "";
  for (const share of rollout) {
    cumulative += share.weight;
    lastName = share.variantName;
    // `< cumulative` (not `<=`) keeps each boundary half-open so a key on a
    // boundary lands in exactly one bucket and never double-counts.
    if (point < cumulative) {
      return share.variantName;
    }
  }

  // Valid input guarantees a non-empty rollout, so `lastName` is always a real
  // Variant name here (the loop ran at least once).
  return lastName;
}

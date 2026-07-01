import { fractionalEval, type Rollout } from "./fractional-eval.js";
import type { RunConfig } from "./run-config.js";

/**
 * Turn the name-keyed `allocation` record into an ordered weight set.
 *
 * Object key iteration order is engine-dependent for some key shapes, and the
 * determinism contract demands identical output across runtimes, so the rollout
 * is sorted by Variant name. This canonical ordering makes the bucket boundaries
 * a pure function of the allocation contents, independent of how the record was
 * constructed or serialized.
 */
function allocationToRollout(allocation: Record<string, number>): Rollout {
  return Object.entries(allocation)
    .map(([variantName, weight]) => ({ variantName, weight }))
    .sort((a, b) => (a.variantName < b.variantName ? -1 : a.variantName > b.variantName ? 1 : 0));
}

/**
 * assign(run, targetingKey) -> Variant NAME.
 *
 * The single bucketing primitive (ADR-0001: assignment is pure, not an event).
 * Deterministic over a frozen Run: the same `(run.salt, run.allocation,
 * targetingKey)` always resolves to the same Variant name, across POPs,
 * runtimes, and time. The Run's `allocation` IS the split — a key that lands in
 * a bucket can never flip Variant while the Run config is frozen, because the
 * hash, the ordering, and the boundaries are all pure functions of the inputs.
 *
 * Pure: no I/O, no Date.now/Math.random, no side effects. Assumes valid input
 * (allocation sums to 100, validated at the write boundary) and never returns an
 * error (docs/spec/evaluation/assign-pure-function.md, error contract).
 */
export function assign(run: RunConfig, targetingKey: string): string {
  return fractionalEval(run.salt, targetingKey, allocationToRollout(run.allocation));
}

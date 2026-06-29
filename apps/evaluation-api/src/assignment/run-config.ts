import type { TargetingRule, Variant } from "@splitch/contracts";

/**
 * The clean, assign()-shaped Run configuration.
 *
 * This is the frozen snapshot `assign()` reads. It deliberately does NOT equal
 * any KV blob: assign() must not depend on a storage shape, so the KV-to-domain
 * mapping lives in one adapter (run-config-adapter.ts) and assign() takes this
 * shape only. `targetingKey` (the EvaluationContext field name to bucket on)
 * lives on the Experiment in KV, so the adapter folds it in here — assign()
 * never reaches across two KV shapes itself.
 *
 * `allocation` is keyed by Variant NAME and the percentages sum to 100, mirroring
 * the Run leaf (docs/spec/contracts/leaf-schemas-experiment.md).
 */
export type RunConfig = {
  runId: string;
  salt: string;
  /** Variant name -> percentage in [0, 100]; percentages sum to 100. */
  allocation: Record<string, number>;
  variantSet: Variant[];
  targetingRules: TargetingRule[];
  /** EvaluationContext field name the Experiment buckets on (e.g. "userId"). */
  targetingKey: string;
};

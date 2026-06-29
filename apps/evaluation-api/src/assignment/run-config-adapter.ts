import type { ExperimentConfigKV, RunConfigKV } from "@splitch/contracts";
import type { RunConfig } from "./run-config.js";

/**
 * Assemble the clean, assign()-shaped `RunConfig` from the two KV blobs the edge
 * reads. This is the ONLY place that knows the KV storage shape: assign() takes
 * `RunConfig`, never a KV blob, so the storage layout can change without touching
 * the pure bucketing core.
 *
 * `targetingKey` is intentionally absent from `RunConfigKV` — it lives on the
 * Experiment (docs/spec/contracts/storage-schemas-kv.md) — so it is folded in
 * here from `ExperimentConfigKV`. The two blobs are read together on the evaluate
 * path; this adapter is the seam where they become one domain object.
 *
 * Pure mapping only: no validation (the blobs are already Zod-parsed at the read
 * boundary) and no I/O.
 */
export function runConfigFromKV(run: RunConfigKV, experiment: ExperimentConfigKV): RunConfig {
  return {
    runId: run.id,
    salt: run.salt,
    allocation: run.allocation,
    variantSet: run.variantSet,
    targetingRules: run.targetingRules,
    targetingKey: experiment.targetingKey,
  };
}

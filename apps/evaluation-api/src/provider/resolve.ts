import type { ExperimentConfigKV, FlagConfigKV, RunConfigKV } from "@splitch/contracts";
import { runConfigFromKV } from "../assignment/run-config-adapter.js";
import { type ExperimentConfig, type FlagConfig, ProviderError } from "./provider.js";

/**
 * Pure KV-blob -> resolved-view mappings. No I/O and no Zod parsing here — the
 * blobs are already validated at the read boundary (kv-provider.ts). This is the
 * one place the resolved evaluate-path VIEW is assembled from storage shapes, so
 * the storage layout can change without touching the evaluate path.
 */

/**
 * Resolve FlagConfigKV into the evaluate-path FlagConfig view.
 *
 * The evaluate path works in Variant NAMES, so the stored `defaultVariantId` (an
 * id) is resolved into the Variant NAME here. A `defaultVariantId` that names no
 * Variant in the catalog is a corrupt config — it throws loudly rather than
 * letting a flag resolve with no usable default (fail-loud, ADR-0036).
 *
 * `experimentId` rides straight through from the KV blob: the controlling
 * Experiment was read in the SAME getFlag read, never a second lookup.
 */
export function flagConfigFromKV(appId: string, blob: FlagConfigKV): FlagConfig {
  const defaultVariant = blob.variants.find((v) => v.id === blob.defaultVariantId);
  if (defaultVariant === undefined) {
    throw new ProviderError(
      `FlagConfig ${appId}/${blob.environmentId}/${blob.key}: defaultVariantId ` +
        `"${blob.defaultVariantId}" names no Variant in the catalog`,
    );
  }

  return {
    flagKey: blob.key,
    appId,
    environmentId: blob.environmentId,
    experimentId: blob.experimentId,
    enabled: blob.enabled,
    defaultVariant: defaultVariant.name,
    variants: blob.variants,
    targetingRules: blob.targetingRules,
  };
}

/**
 * Resolve ExperimentConfigKV (+ the optional live RunConfigKV) into the
 * ExperimentConfig view with the live Run hydrated INLINE as an assign()-shaped
 * RunConfig. `targetingKey` is folded into the RunConfig from the Experiment blob
 * (it is absent from RunConfigKV) via the shared run-config adapter.
 *
 * Invariants enforced loudly: a live Run pointer (`liveRunId`) with no run blob,
 * or a run blob whose `experimentId` disagrees with the Experiment, is corrupt
 * config and throws — never a half-hydrated Experiment into assign().
 */
export function experimentConfigFromKV(
  appId: string,
  experiment: ExperimentConfigKV,
  run: RunConfigKV | null,
): ExperimentConfig {
  if (experiment.liveRunId !== null && run === null) {
    throw new ProviderError(
      `ExperimentConfig ${appId}/${experiment.environmentId}/${experiment.id}: ` +
        `liveRunId "${experiment.liveRunId}" has no live Run config`,
    );
  }
  if (run !== null && run.id !== experiment.liveRunId) {
    throw new ProviderError(
      `ExperimentConfig ${appId}/${experiment.environmentId}/${experiment.id}: ` +
        `run "${run.id}" is not the live Run "${experiment.liveRunId}"`,
    );
  }
  if (run !== null && run.experimentId !== experiment.id) {
    throw new ProviderError(
      `ExperimentConfig ${appId}/${experiment.environmentId}/${experiment.id}: ` +
        `run "${run.id}" belongs to Experiment "${run.experimentId}"`,
    );
  }

  return {
    experimentId: experiment.id,
    appId,
    environmentId: experiment.environmentId,
    targetingKeyType: experiment.targetingKeyType,
    status: experiment.status,
    liveRunId: experiment.liveRunId,
    liveRun: run === null ? null : runConfigFromKV(run, experiment),
  };
}

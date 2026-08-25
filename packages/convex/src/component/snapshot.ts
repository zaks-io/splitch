import {
  type ConvexConfigSnapshot,
  ConvexConfigSnapshotSchema,
  type ExperimentConfigKV,
  type FlagConfigKV,
  type RunConfigKV,
} from "@splitch/contracts";
import {
  type ExperimentConfig,
  type FlagConfig,
  type Provider,
  ProviderError,
} from "@splitch/evaluation-core";

export function parseSnapshot(payload: string): ConvexConfigSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch (cause) {
    throw new ProviderError("Stored Convex configuration is malformed JSON", { cause });
  }
  const parsed = ConvexConfigSnapshotSchema.safeParse(value);
  if (!parsed.success)
    throw new ProviderError(`Stored Convex configuration is invalid: ${parsed.error.message}`);
  assertSnapshotReferences(parsed.data);
  return parsed.data;
}

export function snapshotProvider(snapshot: ConvexConfigSnapshot): Provider {
  const flags = new Map(snapshot.flags.map((flag) => [flag.key, resolveFlag(snapshot, flag)]));
  const experiments = new Map(
    snapshot.experiments.map((experiment) => [
      experiment.id,
      resolveExperiment(snapshot, experiment),
    ]),
  );
  return {
    async getFlag(appId, environmentId, flagKey) {
      assertScope(snapshot, appId, environmentId);
      const flag = flags.get(flagKey);
      if (!flag)
        throw new ProviderError(`Flag "${flagKey}" is absent from the Convex snapshot`, {
          errorCode: "FLAG_NOT_FOUND",
        });
      return flag;
    },
    async getFlags(appId, environmentId) {
      assertScope(snapshot, appId, environmentId);
      return [...flags.values()];
    },
    async getExperiment(appId, environmentId, experimentId) {
      assertScope(snapshot, appId, environmentId);
      const experiment = experiments.get(experimentId);
      if (!experiment)
        throw new ProviderError(`Experiment "${experimentId}" is absent from the Convex snapshot`);
      return experiment;
    },
  };
}

function resolveFlag(snapshot: ConvexConfigSnapshot, flag: FlagConfigKV): FlagConfig {
  const defaultVariant = flag.variants.find((variant) => variant.id === flag.defaultVariantId);
  if (!defaultVariant)
    throw new ProviderError(`Flag "${flag.key}" defaultVariantId names no Variant`);
  return {
    flagKey: flag.key,
    appId: snapshot.appId,
    environmentId: snapshot.environmentId,
    experimentId: flag.experimentId,
    enabled: flag.enabled,
    defaultVariant: defaultVariant.name,
    variants: flag.variants,
    availableVariantNames: flag.availableVariantNames,
    targetingRules: flag.targetingRules,
    rollout: flag.rollout,
  };
}

function resolveExperiment(
  snapshot: ConvexConfigSnapshot,
  experiment: ExperimentConfigKV,
): ExperimentConfig {
  const run =
    experiment.liveRunId === null
      ? null
      : snapshot.runs.find((candidate) => candidate.id === experiment.liveRunId);
  if (experiment.liveRunId !== null && !run)
    throw new ProviderError(`Experiment "${experiment.id}" liveRunId names no Run`);
  return {
    experimentId: experiment.id,
    appId: snapshot.appId,
    environmentId: snapshot.environmentId,
    targetingKeyType: experiment.targetingKeyType,
    status: experiment.status,
    liveRunId: experiment.liveRunId,
    liveRun: run ? resolveRun(experiment, run) : null,
  };
}

function resolveRun(experiment: ExperimentConfigKV, run: RunConfigKV) {
  if (run.experimentId !== experiment.id)
    throw new ProviderError(`Run "${run.id}" belongs to a different Experiment`);
  return {
    runId: run.id,
    salt: run.salt,
    allocation: run.allocation,
    variantSet: run.variantSet,
    targetingRules: run.targetingRules,
    targetingKey: experiment.targetingKey,
    configHash: run.configHash,
  };
}

function assertScope(snapshot: ConvexConfigSnapshot, appId: string, environmentId: string) {
  if (snapshot.appId !== appId || snapshot.environmentId !== environmentId) {
    throw new ProviderError("Convex snapshot scope does not match the installed integration");
  }
}

function assertSnapshotReferences(snapshot: ConvexConfigSnapshot): void {
  uniqueScopedIds(
    snapshot.flags.map((flag) => ({ id: flag.key, environmentId: flag.environmentId })),
    snapshot.environmentId,
    "Flag",
  );
  const experimentIds = uniqueScopedIds(
    snapshot.experiments.map((experiment) => ({
      id: experiment.id,
      environmentId: experiment.environmentId,
    })),
    snapshot.environmentId,
    "Experiment",
  );
  const runIds = uniqueRunIds(snapshot, experimentIds);
  for (const flag of snapshot.flags) {
    if (flag.experimentId !== null && !experimentIds.has(flag.experimentId)) {
      throw new ProviderError(`Flag "${flag.key}" names an absent Experiment`);
    }
  }
  for (const experiment of snapshot.experiments) {
    if (experiment.liveRunId !== null && !runIds.has(experiment.liveRunId)) {
      throw new ProviderError(`Experiment "${experiment.id}" names an absent live Run`);
    }
  }
}

function uniqueScopedIds(
  values: Array<{ id: string; environmentId: string }>,
  environmentId: string,
  kind: "Flag" | "Experiment",
): Set<string> {
  const ids = new Set<string>();
  for (const value of values) {
    if (value.environmentId !== environmentId) {
      throw new ProviderError(`${kind} "${value.id}" crosses Environment scope`);
    }
    if (ids.has(value.id)) {
      throw new ProviderError(`Duplicate ${kind} "${value.id}" in Convex snapshot`);
    }
    ids.add(value.id);
  }
  return ids;
}

function uniqueRunIds(
  snapshot: ConvexConfigSnapshot,
  experimentIds: ReadonlySet<string>,
): Set<string> {
  const ids = new Set<string>();
  for (const run of snapshot.runs) {
    if (ids.has(run.id)) throw new ProviderError(`Duplicate Run "${run.id}" in Convex snapshot`);
    if (!experimentIds.has(run.experimentId)) {
      throw new ProviderError(`Run "${run.id}" names an absent Experiment`);
    }
    ids.add(run.id);
  }
  return ids;
}

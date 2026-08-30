import {
  type ConfigSnapshot,
  ConfigSnapshotSchema,
  ExperimentConfigKVSchema,
  FlagConfigKVSchema,
  type ResolvedTargetingRule,
  RunConfigKVSchema,
  type Variant,
} from "@splitch/contracts";
import { appScope, type EnvScope, type Repository } from "@splitch/db";
import { toTargetingRule } from "./config-store-shared";
import { parseStoredRollout } from "./flag-config-rollout";
import { requireResolvedTargetingRules, resolveTargetingRules } from "./targeting-rule-resolution";

export async function buildIntegrationSnapshot(
  repo: Repository,
  scope: EnvScope,
  environmentVersion: number,
): Promise<ConfigSnapshot> {
  const flags = await repo.flags.flags.findMany(appScope(scope.appId));
  if (flags.length === 0)
    return ConfigSnapshotSchema.parse({
      schemaVersion: 1,
      environmentVersion,
      appId: scope.appId,
      environmentId: scope.environmentId,
      flags: [],
      experiments: [],
      runs: [],
    });
  const flagIds = flags.map((flag) => flag.id);
  const [configs, variantsByFlag, targetingRows, experiments] = await Promise.all([
    repo.flags.listFlagConfigsByFlagIds(scope, flagIds),
    repo.flags.listVariantsForFlags(appScope(scope.appId), flagIds),
    repo.flags.listTargetingRulesByFlagIds(scope, flagIds),
    repo.experiments.listRunningExperimentsForFlags(scope, flagIds),
  ]);
  const runs = await repo.experiments.listRunsByIds(
    scope,
    experiments.flatMap((experiment) => (experiment.liveRunId ? [experiment.liveRunId] : [])),
  );
  const resolvedRules = requireResolvedTargetingRules(
    await resolveTargetingRules(repo, scope.appId, targetingRows.map(toTargetingRule)),
  );
  const configsByFlag = uniqueBy(configs, (config) => config.flagId, "Flag Configuration");
  const experimentsByFlag = uniqueBy(experiments, (experiment) => experiment.flagId, "Experiment");
  const runsById = uniqueBy(runs, (run) => run.id, "Experiment Run");
  const rulesByFlag = groupBy(resolvedRules, (rule) => rule.flagId);

  const snapshotFlags = flags.flatMap((flag) => {
    const config = configsByFlag.get(flag.id);
    if (!config) return [];
    const experiment = experimentsByFlag.get(flag.id);
    const variants = (variantsByFlag.get(flag.id) ?? []).map((variant) => ({
      id: variant.id,
      name: variant.name,
      value: JSON.parse(variant.value) as Variant["value"],
      ...(variant.description ? { description: variant.description } : {}),
    }));
    return [
      FlagConfigKVSchema.parse({
        id: flag.id,
        key: flag.key,
        environmentId: scope.environmentId,
        experimentId: experiment?.id ?? null,
        enabled: config.enabled,
        defaultVariantId: required(config.defaultVariantId, "defaultVariantId"),
        variants,
        availableVariantNames: JSON.parse(config.availableVariantNames) as string[],
        targetingRules: rulesByFlag.get(flag.id) ?? [],
        rollout: parseStoredRollout(config.rollout),
        updatedAt: config.updatedAt,
      }),
    ];
  });
  const snapshotExperiments = flags.flatMap((flag) => {
    const experiment = experimentsByFlag.get(flag.id);
    if (!experiment || !configsByFlag.has(flag.id)) return [];
    return [
      ExperimentConfigKVSchema.parse({
        id: experiment.id,
        environmentId: scope.environmentId,
        flagId: experiment.flagId,
        targetingKey: experiment.targetingKeyField,
        targetingKeyType: experiment.targetingKeyType,
        status: experiment.status,
        liveRunId: experiment.liveRunId,
      }),
    ];
  });
  const snapshotRuns = snapshotExperiments.flatMap((experiment) => {
    if (!experiment.liveRunId) return [];
    const run = runsById.get(experiment.liveRunId);
    if (!run)
      throw new Error(
        `integration-snapshot: Experiment "${experiment.id}" points at missing Run "${experiment.liveRunId}"`,
      );
    return [
      RunConfigKVSchema.parse({
        id: run.id,
        experimentId: run.experimentId,
        salt: run.salt,
        allocation: JSON.parse(run.allocation) as Record<string, number>,
        variantSet: JSON.parse(run.variantSet) as Variant[],
        targetingRules: JSON.parse(run.targetingRules) as ResolvedTargetingRule[],
        configHash: run.configHash,
        startedAt: run.startedAt,
      }),
    ];
  });
  return ConfigSnapshotSchema.parse({
    schemaVersion: 1,
    environmentVersion,
    appId: scope.appId,
    environmentId: scope.environmentId,
    flags: snapshotFlags,
    experiments: snapshotExperiments,
    runs: snapshotRuns,
  });
}

function uniqueBy<T>(
  values: readonly T[],
  key: (value: T) => string,
  label: string,
): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    const id = key(value);
    if (result.has(id)) throw new Error(`integration-snapshot: multiple ${label}s for "${id}"`);
    result.set(id, value);
  }
  return result;
}

function groupBy<T>(values: readonly T[], key: (value: T) => string): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const value of values) {
    const id = key(value);
    const group = result.get(id);
    if (group) group.push(value);
    else result.set(id, [value]);
  }
  return result;
}

function required(value: string | null, field: string): string {
  if (!value) throw new Error(`integration-snapshot: missing ${field}`);
  return value;
}

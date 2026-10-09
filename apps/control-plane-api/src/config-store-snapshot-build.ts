import {
  ExperimentConfigKVSchema,
  FlagConfigKVSchema,
  type ResolvedTargetingRule,
  RunConfigKVSchema,
  TargetingRuleSchema,
  type Variant,
} from "@splitch/contracts";
import { appScope, type EnvScope, type Repository } from "@splitch/db";
import { activationBindingsForExperiment } from "./config-store-activation-bindings";
import type { Snapshot } from "./config-store-types";
import { parseStoredRollout } from "./flag-config-rollout";
import { requireResolvedTargetingRules, resolveTargetingRules } from "./targeting-rule-resolution";

type SnapshotRows = Exclude<
  Awaited<ReturnType<Repository["flagEvaluation"]["readFlagSnapshotInputsByKey"]>>,
  "moved" | null
>;

interface SnapshotInputs {
  experiment: Awaited<ReturnType<Repository["experiments"]["getExperiment"]>>;
  flag: SnapshotRows["flag"];
  config: NonNullable<SnapshotRows["config"]>;
  variants: Variant[];
  authoringRows: SnapshotRows["targetingRules"];
}

export async function buildSnapshotFromD1(
  repo: Repository,
  scope: EnvScope,
  flagId: string,
): Promise<Snapshot | null> {
  return buildSnapshot(
    repo,
    scope,
    flagId,
    repo.experiments.findRunningExperimentForFlag(scope, flagId),
  );
}

export async function buildExperimentSnapshotFromD1(
  repo: Repository,
  scope: EnvScope,
  experimentId: string,
): Promise<Snapshot | null> {
  const experiment = await repo.experiments.getExperiment(scope, experimentId);
  if (!experiment) return null;
  return buildSnapshot(repo, scope, experiment.flagId, Promise.resolve(experiment));
}

/**
 * The evaluation read, addressed by Flag key so the key lookup shares one D1
 * round with every read that depends on it. A key that moved to another Flag
 * mid-read takes the sequential path instead of mixing the two Flags' rows.
 */
export async function buildEvaluationSnapshotFromD1(
  repo: Repository,
  scope: EnvScope,
  flagKey: string,
): Promise<Snapshot | null> {
  const rows = await repo.flagEvaluation.readFlagSnapshotInputsByKey(scope, flagKey);
  if (rows === "moved") {
    const flag = await repo.flags.getFlagByKey(appScope(scope.appId), flagKey);
    return flag ? buildSnapshotFromD1(repo, scope, flag.id) : null;
  }
  if (!rows?.config) return null;
  return assembleSnapshot(repo, scope, {
    experiment: rows.runningExperiment,
    flag: rows.flag,
    config: rows.config,
    variants: rows.variants.map(toVariant),
    authoringRows: rows.targetingRules,
  });
}

async function buildSnapshot(
  repo: Repository,
  scope: EnvScope,
  flagId: string,
  experimentResult: Promise<SnapshotInputs["experiment"]>,
): Promise<Snapshot | null> {
  const [experiment, inputs, authoringRows] = await Promise.all([
    experimentResult,
    loadFlagConfigWriteContext(repo, scope, flagId),
    repo.flags.listTargetingRules(scope, flagId),
  ]);
  if (!inputs) return null;
  return assembleSnapshot(repo, scope, { experiment, ...inputs, authoringRows });
}

async function assembleSnapshot(
  repo: Repository,
  scope: EnvScope,
  { experiment, flag, config, variants, authoringRows }: SnapshotInputs,
): Promise<Snapshot> {
  const authoringTargetingRules = authoringRows.map(toTargetingRule);
  const [resolution, run] = await Promise.all([
    resolveTargetingRules(repo, scope.appId, authoringTargetingRules),
    experiment?.liveRunId
      ? repo.experiments.getRun(scope, experiment.liveRunId)
      : Promise.resolve(null),
  ]);
  const resolved = requireResolvedTargetingRules(resolution);
  if (experiment?.liveRunId && !run) {
    throw new Error("config-store: experiment liveRunId points at no Run");
  }
  const activationBindings = await activationBindingsForExperiment(repo, scope, experiment);

  return {
    flag: FlagConfigKVSchema.parse({
      id: flag.id,
      key: flag.key,
      environmentId: scope.environmentId,
      experimentId: experiment?.status === "running" ? experiment.id : null,
      enabled: config.enabled,
      defaultVariantId: requiredString(config.defaultVariantId, "defaultVariantId"),
      variants,
      availableVariantNames: JSON.parse(config.availableVariantNames) as string[],
      targetingRules: resolved,
      rollout: parseStoredRollout(config.rollout),
      updatedAt: config.updatedAt,
    }),
    authoringTargetingRules,
    experiment: experimentConfig(scope, experiment),
    controllingExperiment:
      experiment?.status === "running" ? { id: experiment.id, name: experiment.name } : null,
    run: runConfig(run),
    activationBindings,
    version: config.version,
  };
}

export async function loadFlagConfigWriteContext(
  repo: Repository,
  scope: EnvScope,
  flagId: string,
) {
  const [flag, config, variantCatalogs] = await Promise.all([
    repo.flags.getFlag(appScope(scope.appId), flagId),
    repo.flags.getFlagConfig(scope, flagId),
    repo.flags.listVariantsForFlags(appScope(scope.appId), [flagId]),
  ]);
  if (!flag || !config) return null;
  const variants = (variantCatalogs.get(flagId) ?? []).map(toVariant);
  return { flag, config, variants };
}

function toVariant(row: SnapshotRows["variants"][number]): Variant {
  return {
    id: row.id,
    name: row.name,
    value: JSON.parse(row.value) as Variant["value"],
    ...(row.description ? { description: row.description } : {}),
  };
}

function experimentConfig(scope: EnvScope, experiment: SnapshotInputs["experiment"]) {
  if (!experiment) return null;
  return ExperimentConfigKVSchema.parse({
    id: experiment.id,
    environmentId: scope.environmentId,
    flagId: experiment.flagId,
    targetingKey: experiment.targetingKeyField,
    targetingKeyType: experiment.targetingKeyType,
    status: experiment.status,
    liveRunId: experiment.liveRunId,
  });
}

function runConfig(run: Awaited<ReturnType<Repository["experiments"]["getRun"]>>) {
  if (!run) return null;
  return RunConfigKVSchema.parse({
    id: run.id,
    experimentId: run.experimentId,
    salt: run.salt,
    allocation: JSON.parse(run.allocation) as Record<string, number>,
    variantSet: JSON.parse(run.variantSet) as Variant[],
    targetingRules: JSON.parse(run.targetingRules) as ResolvedTargetingRule[],
    configHash: run.configHash,
    startedAt: run.startedAt,
  });
}

export function toTargetingRule(
  rule: Awaited<ReturnType<Repository["flags"]["listTargetingRules"]>>[number],
) {
  return TargetingRuleSchema.parse({
    id: rule.id,
    flagId: rule.flagId,
    priority: rule.priority,
    conditions: JSON.parse(rule.conditions),
    ...(rule.segmentId ? { segmentId: rule.segmentId } : {}),
    variantId: requiredString(rule.variantId, "variantId"),
    ...(rule.percentageRollout ? { percentageRollout: JSON.parse(rule.percentageRollout) } : {}),
  });
}

function requiredString(value: string | null, name: string): string {
  if (!value) throw new Error(`config-store: missing ${name}`);
  return value;
}

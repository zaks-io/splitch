import {
  DeltaNudgeSchema,
  ExperimentConfigKVSchema,
  FlagConfigKVSchema,
  flagConfigKey,
  type ResolvedTargetingRule,
  RunConfigKVSchema,
  type TargetingRule,
  TargetingRuleSchema,
  type Variant,
} from "@splitch/contracts";
import { appScope, type EnvScope, type Repository } from "@splitch/db";
import { activationBindingsForExperiment } from "./config-store-activation-bindings";
import { parseFlagConfigEnvelope, writeSnapshot } from "./config-store-kv";
import type {
  ApplyApprovedFlagConfigInput,
  ConfigStoreDeps,
  ConfigStoreRuntimeDeps,
  FlagConfigResult,
  FlagConfigWriteResult,
  PatchFlagConfigInput,
  PromoteFlagConfigInput,
  PromoteFlagConfigResult,
  ReplaceTargetingRulesInput,
  Snapshot,
} from "./config-store-types";
import { parseStoredRollout } from "./flag-config-rollout";
import { requireResolvedTargetingRules, resolveTargetingRules } from "./targeting-rule-resolution";

export type {
  ApplyApprovedFlagConfigInput,
  ConfigStoreDeps,
  ConfigStoreRuntimeDeps,
  FlagConfigResult,
  FlagConfigWriteResult,
  PatchFlagConfigInput,
  PromoteFlagConfigInput,
  PromoteFlagConfigResult,
  ReplaceTargetingRulesInput,
  Snapshot,
};

export async function readFlagSnapshot(
  deps: ConfigStoreRuntimeDeps,
  scope: EnvScope,
  flagId: string,
): Promise<Snapshot | null> {
  const fromD1 = await buildSnapshotFromD1(deps.repo, scope, flagId);
  if (!fromD1) return null;

  const key = flagConfigKey(scope.appId, scope.environmentId, fromD1.flag.key);
  const raw = await deps.kv.get(key, "text");
  if (!raw) {
    return deps.snapshotMutations.run(async () => {
      const repair = await buildSnapshotFromD1(deps.repo, scope, flagId);
      if (!repair) return null;
      await writeSnapshot(
        deps.kv,
        scope,
        repair,
        responseFromSnapshot(repair),
        await deps.nextSnapshotRevision({ flagId, operation: "repair" }),
      );
      return repair;
    });
  }

  try {
    return { ...fromD1, flag: parseFlagConfigEnvelope(raw) };
  } catch (cause) {
    deps.logger?.warn("config_store_kv_schema_mismatch", { key, cause });
    throw cause;
  }
}

export async function readFlagConfigPurgeTarget(
  deps: ConfigStoreRuntimeDeps,
  scope: EnvScope,
  flagId: string,
): Promise<{ experimentIds: string[] } | null> {
  const [flag, experiments] = await Promise.all([
    deps.repo.flags.getFlag(appScope(scope.appId), flagId),
    deps.repo.experiments.listExperimentsForFlag(scope, flagId),
  ]);
  if (!flag) return null;

  return { experimentIds: experiments.map((experiment) => experiment.id) };
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

async function buildSnapshot(
  repo: Repository,
  scope: EnvScope,
  flagId: string,
  experimentResult: Promise<Awaited<ReturnType<Repository["experiments"]["getExperiment"]>>>,
): Promise<Snapshot | null> {
  const [experiment, inputs, authoringRows] = await Promise.all([
    experimentResult,
    loadFlagConfigWriteContext(repo, scope, flagId),
    repo.flags.listTargetingRules(scope, flagId),
  ]);
  if (!inputs) return null;
  const { flag, config, variants } = inputs;

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
  const variantRows = variantCatalogs.get(flagId) ?? [];
  const variants = variantRows.map((v) => ({
    id: v.id,
    name: v.name,
    value: JSON.parse(v.value) as Variant["value"],
    ...(v.description ? { description: v.description } : {}),
  }));
  return { flag, config, variants };
}

/**
 * The same successful shape, for a write that turned out to change nothing: no
 * D1 row, no KV blob, no nudge. The `version` reported is the CURRENT one, which
 * is the point — a caller holding it as a concurrency token still holds a valid
 * one after a no-op.
 */
export function flagConfigResult(
  flagId: string,
  snapshot: Snapshot,
): Extract<FlagConfigWriteResult, { ok: true }> {
  const nudge = DeltaNudgeSchema.parse({
    type: "config.changed",
    entity: "flag",
    id: flagId,
    version: snapshot.version,
  });
  return { ok: true, config: responseFromSnapshot(snapshot), nudge, snapshotRevision: null };
}

export function responseFromSnapshot(snapshot: Snapshot): FlagConfigResult {
  return {
    flagId: snapshot.flag.id,
    environmentId: snapshot.flag.environmentId,
    version: snapshot.version,
    enabled: snapshot.flag.enabled,
    availableVariantNames: snapshot.flag.availableVariantNames,
    targetingRules: snapshot.authoringTargetingRules,
    rollout: snapshot.flag.rollout,
    experiment: snapshot.controllingExperiment,
  };
}

export function targetingRuleRows(rules: TargetingRule[], now: Date) {
  const timestamp = now.toISOString();
  return rules.map((rule) => ({
    id: rule.id,
    priority: rule.priority,
    conditions: json(rule.conditions),
    segmentId: rule.segmentId ?? null,
    variantId: rule.variantId,
    percentageRollout: rule.percentageRollout ? json(rule.percentageRollout) : null,
    createdAt: timestamp,
    updatedAt: timestamp,
  }));
}

export function missingAvailableVariants(
  names: string[] | undefined,
  variants: Variant[],
): string[] {
  if (!names) return [];
  const catalog = new Set(variants.map((variant) => variant.name));
  return names.filter((name) => !catalog.has(name));
}

export function missingRuleVariantNames(
  rules: readonly Pick<TargetingRule, "variantId">[],
  variants: readonly Pick<Variant, "id" | "name">[],
  availableVariantNames: readonly string[],
): string[] {
  // Empty means the catalog has never been narrowed, so every Variant remains
  // available to Targeting Rules.
  if (availableVariantNames.length === 0) return [];
  const available = new Set(availableVariantNames);
  const namesById = new Map(variants.map((variant) => [variant.id, variant.name]));
  const missing = new Set<string>();
  for (const rule of rules) {
    const name = namesById.get(rule.variantId);
    if (!name) {
      missing.add(rule.variantId);
      continue;
    }
    if (!available.has(name)) missing.add(name);
  }
  return [...missing];
}

export function json(value: unknown): string {
  return JSON.stringify(value);
}

function experimentConfig(
  scope: EnvScope,
  experiment: Awaited<ReturnType<Repository["experiments"]["findRunningExperimentForFlag"]>>,
) {
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

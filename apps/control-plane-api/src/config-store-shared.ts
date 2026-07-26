import {
  DeltaNudgeSchema,
  ExperimentConfigKVSchema,
  FlagConfigKVSchema,
  RunConfigKVSchema,
  TargetingRuleSchema,
  flagConfigKey,
  type DeltaNudge,
  type ExperimentConfigKV,
  type FlagConfigKV,
  type PercentageRollout,
  type RunConfigKV,
  type TargetingRule,
  type Variant,
} from "@splitch/contracts";
import { appScope, type EnvScope, type Repository } from "@splitch/db";
import { parseFlagConfigEnvelope, writeSnapshot } from "./config-store-kv";
import { parseStoredRollout } from "./flag-config-rollout";

export interface FlagConfigResult {
  flagId: string;
  environmentId: string;
  version: number;
  enabled: boolean;
  availableVariantNames: string[];
  targetingRules: TargetingRule[];
  rollout: PercentageRollout | null;
}

export interface PatchFlagConfigInput {
  appId: string;
  environmentId: string;
  flagId: string;
  enabled?: boolean;
  availableVariantNames?: string[];
  /** Percentage only; the salt is the store's to mint and preserve. */
  rollout?: { percentage: number } | null;
}

export interface ReplaceTargetingRulesInput {
  appId: string;
  environmentId: string;
  flagId: string;
  targetingRules: TargetingRule[];
}

export interface PromoteFlagConfigInput {
  appId: string;
  targetEnvironmentId: string;
  flagId: string;
  fromEnvironmentId: string;
  select: {
    availability?: string[];
    targeting?: true;
    rollout?: true;
    enabled?: true;
  };
}

export type FlagConfigWriteResult =
  | { ok: true; config: FlagConfigResult; nudge: DeltaNudge }
  | { ok: false; reason: "FLAG_NOT_FOUND" }
  | { ok: false; reason: "VARIANT_NOT_AVAILABLE"; missingVariants: string[] };

export type PromoteFlagConfigResult =
  | {
      ok: true;
      config: FlagConfigResult;
      diff: { before: FlagConfigResult; after: FlagConfigResult };
      nudge: DeltaNudge;
    }
  | { ok: false; reason: "FLAG_NOT_FOUND" }
  | { ok: false; reason: "VARIANT_NOT_AVAILABLE"; missingVariants: string[] };

export interface ConfigStoreDeps {
  repo: Repository;
  kv: KVNamespace;
  broadcaster: { broadcast(nudge: DeltaNudge): Promise<void> | void };
  logger?: Pick<Console, "warn">;
  now?: () => Date;
}

export interface Snapshot {
  flag: FlagConfigKV;
  experiment: ExperimentConfigKV | null;
  run: RunConfigKV | null;
  version: number;
}

export async function readFlagSnapshot(
  deps: ConfigStoreDeps,
  scope: EnvScope,
  flagId: string,
): Promise<Snapshot | null> {
  const fromD1 = await buildSnapshotFromD1(deps.repo, scope, flagId);
  if (!fromD1) return null;

  const key = flagConfigKey(scope.appId, scope.environmentId, fromD1.flag.key);
  const raw = await deps.kv.get(key, "text");
  if (!raw) {
    await writeSnapshot(deps.kv, scope, fromD1);
    return fromD1;
  }

  try {
    return { ...fromD1, flag: parseFlagConfigEnvelope(raw) };
  } catch (cause) {
    deps.logger?.warn("config_store_kv_schema_mismatch", { key, cause });
    await writeSnapshot(deps.kv, scope, fromD1);
    return fromD1;
  }
}

export async function buildSnapshotFromD1(
  repo: Repository,
  scope: EnvScope,
  flagId: string,
): Promise<Snapshot | null> {
  const experiment = await repo.experiments.findRunningExperimentForFlag(scope, flagId);
  return buildSnapshot(repo, scope, flagId, experiment);
}

export async function buildExperimentSnapshotFromD1(
  repo: Repository,
  scope: EnvScope,
  experimentId: string,
): Promise<Snapshot | null> {
  const experiment = await repo.experiments.getExperiment(scope, experimentId);
  if (!experiment) return null;
  return buildSnapshot(repo, scope, experiment.flagId, experiment);
}

async function buildSnapshot(
  repo: Repository,
  scope: EnvScope,
  flagId: string,
  experiment: Awaited<ReturnType<Repository["experiments"]["getExperiment"]>>,
): Promise<Snapshot | null> {
  const flag = await repo.flags.getFlag(appScope(scope.appId), flagId);
  const config = await repo.flags.getFlagConfig(scope, flagId);
  if (!flag || !config) return null;

  const variants = (await repo.flags.listVariants(appScope(scope.appId), flagId)).map((v) => ({
    id: v.id,
    name: v.name,
    value: JSON.parse(v.value) as Variant["value"],
    ...(v.description ? { description: v.description } : {}),
  }));

  const targetingRules = (await repo.flags.listTargetingRules(scope, flagId)).map(toTargetingRule);
  const run = experiment?.liveRunId
    ? await repo.experiments.getRun(scope, experiment.liveRunId)
    : null;
  if (experiment?.liveRunId && !run) {
    throw new Error("config-store: experiment liveRunId points at no Run");
  }

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
      targetingRules,
      rollout: parseStoredRollout(config.rollout),
      updatedAt: config.updatedAt,
    }),
    experiment: experimentConfig(scope, experiment),
    run: runConfig(run),
    version: config.version,
  };
}

export async function writeSnapshotAndBroadcast(
  deps: ConfigStoreDeps,
  scope: EnvScope,
  flagId: string,
  snapshot: Snapshot,
): Promise<FlagConfigWriteResult> {
  await writeSnapshot(deps.kv, scope, snapshot);

  const nudge = DeltaNudgeSchema.parse({
    type: "config.changed",
    entity: "flag",
    id: flagId,
    version: snapshot.version,
  });
  await deps.broadcaster.broadcast(nudge);
  return { ok: true, config: responseFromSnapshot(snapshot), nudge };
}

export function responseFromSnapshot(snapshot: Snapshot): FlagConfigResult {
  return {
    flagId: snapshot.flag.id,
    environmentId: snapshot.flag.environmentId,
    version: snapshot.version,
    enabled: snapshot.flag.enabled,
    availableVariantNames: snapshot.flag.availableVariantNames,
    targetingRules: snapshot.flag.targetingRules,
    rollout: snapshot.flag.rollout,
  };
}

export function targetingRuleRows(rules: TargetingRule[], now: Date) {
  const timestamp = now.toISOString();
  return rules.map((rule) => ({
    id: rule.id,
    priority: rule.priority,
    conditions: json(rule.conditions),
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
  rules: TargetingRule[],
  variants: Variant[],
  availableVariantNames: string[],
): string[] {
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
    targetingRules: JSON.parse(run.targetingRules) as TargetingRule[],
    configHash: run.configHash,
    startedAt: run.startedAt,
  });
}

function toTargetingRule(
  rule: Awaited<ReturnType<Repository["flags"]["listTargetingRules"]>>[number],
) {
  return TargetingRuleSchema.parse({
    id: rule.id,
    flagId: rule.flagId,
    priority: rule.priority,
    conditions: JSON.parse(rule.conditions),
    variantId: requiredString(rule.variantId, "variantId"),
    ...(rule.percentageRollout ? { percentageRollout: JSON.parse(rule.percentageRollout) } : {}),
  });
}

function requiredString(value: string | null, name: string): string {
  if (!value) throw new Error(`config-store: missing ${name}`);
  return value;
}

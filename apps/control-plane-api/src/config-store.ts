import {
  CURRENT_KV_SCHEMA_VERSION,
  DeltaNudgeSchema,
  ExperimentConfigKVSchema,
  FlagConfigKVSchema,
  LiveRunKVSchema,
  RunConfigKVSchema,
  TargetingRuleSchema,
  experimentConfigKey,
  flagConfigKey,
  kvEnvelope,
  liveRunKey,
  runConfigKey,
  type DeltaNudge,
  type ExperimentConfigKV,
  type FlagConfigKV,
  type RunConfigKV,
  type TargetingRule,
  type Variant,
} from "@splitch/contracts";
import { appScope, envScope, type EnvScope, type Repository } from "@splitch/db";

interface FlagConfigResult {
  flagId: string;
  environmentId: string;
  version: number;
  enabled: boolean;
  availableVariantNames: string[];
  targetingRules: TargetingRule[];
}

interface PatchFlagConfigInput {
  appId: string;
  environmentId: string;
  flagId: string;
  enabled?: boolean;
  availableVariantNames?: string[];
}

export interface ConfigStoreWriter {
  readFlagConfig(
    input: Omit<PatchFlagConfigInput, "enabled" | "availableVariantNames">,
  ): Promise<{ ok: true; config: FlagConfigResult } | { ok: false; reason: "FLAG_NOT_FOUND" }>;
  writeFlagConfig(
    input: PatchFlagConfigInput,
  ): Promise<
    | { ok: true; config: FlagConfigResult; nudge: DeltaNudge }
    | { ok: false; reason: "FLAG_NOT_FOUND" }
    | { ok: false; reason: "VARIANT_NOT_AVAILABLE"; missingVariants: string[] }
  >;
}

export interface ConfigStoreDeps {
  repo: Repository;
  kv: KVNamespace;
  broadcaster: { broadcast(nudge: DeltaNudge): Promise<void> | void };
  logger?: Pick<Console, "warn">;
  now?: () => Date;
}

interface Snapshot {
  flag: FlagConfigKV;
  experiment: ExperimentConfigKV | null;
  run: RunConfigKV | null;
  version: number;
}

const FlagConfigEnvelope = kvEnvelope(FlagConfigKVSchema);
const ExperimentConfigEnvelope = kvEnvelope(ExperimentConfigKVSchema);
const RunConfigEnvelope = kvEnvelope(RunConfigKVSchema);
const LiveRunEnvelope = kvEnvelope(LiveRunKVSchema);

export function makeConfigStore(deps: ConfigStoreDeps): ConfigStoreWriter {
  return {
    async readFlagConfig(input) {
      const scope = envScope(input.appId, input.environmentId);
      const snapshot = await readFlagSnapshot(deps, scope, input.flagId);
      if (!snapshot) return { ok: false, reason: "FLAG_NOT_FOUND" };
      return { ok: true, config: responseFromSnapshot(snapshot) };
    },

    async writeFlagConfig(input) {
      const scope = envScope(input.appId, input.environmentId);
      const snapshot = await buildSnapshotFromD1(deps.repo, scope, input.flagId);
      if (!snapshot) return { ok: false, reason: "FLAG_NOT_FOUND" };

      const missingVariants = missingAvailableVariants(
        input.availableVariantNames,
        snapshot.flag.variants,
      );
      if (missingVariants.length > 0) {
        return { ok: false, reason: "VARIANT_NOT_AVAILABLE", missingVariants };
      }

      const commit = await commitFlagConfigPatch(deps, scope, input);
      if (!commit) return { ok: false, reason: "FLAG_NOT_FOUND" };

      await writeSnapshot(deps.kv, scope, commit.snapshot);

      const nudge = DeltaNudgeSchema.parse({
        type: "config.changed",
        entity: "flag",
        id: input.flagId,
        version: commit.version,
      });
      await deps.broadcaster.broadcast(nudge);
      return { ok: true, config: responseFromSnapshot(commit.snapshot), nudge };
    },
  };
}

async function commitFlagConfigPatch(
  deps: ConfigStoreDeps,
  scope: EnvScope,
  input: PatchFlagConfigInput,
): Promise<{ snapshot: Snapshot; version: number } | null> {
  const updated = await deps.repo.flags.updateFlagConfig(scope, input.flagId, {
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    ...(input.availableVariantNames
      ? { availableVariantNames: json(input.availableVariantNames) }
      : {}),
    updatedAt: (deps.now?.() ?? new Date()).toISOString(),
  });
  if (!updated) return null;

  const snapshot = await buildSnapshotFromD1(deps.repo, scope, input.flagId);
  return snapshot ? { snapshot, version: updated.version } : null;
}

async function readFlagSnapshot(
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
    return { ...fromD1, flag: FlagConfigEnvelope.parse(JSON.parse(raw)).data };
  } catch (cause) {
    deps.logger?.warn("config_store_kv_schema_mismatch", { key, cause });
    await writeSnapshot(deps.kv, scope, fromD1);
    return fromD1;
  }
}

async function buildSnapshotFromD1(
  repo: Repository,
  scope: EnvScope,
  flagId: string,
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
  const experiment = await repo.experiments.findRunningExperimentForFlag(scope, flagId);
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
      experimentId: experiment?.id ?? null,
      enabled: config.enabled,
      defaultVariantId: requiredString(config.defaultVariantId, "defaultVariantId"),
      variants,
      availableVariantNames: JSON.parse(config.availableVariantNames) as string[],
      targetingRules,
      updatedAt: config.updatedAt,
    }),
    experiment: experiment
      ? ExperimentConfigKVSchema.parse({
          id: experiment.id,
          environmentId: scope.environmentId,
          flagId: experiment.flagId,
          targetingKey: experiment.targetingKeyField,
          targetingKeyType: experiment.targetingKeyType,
          status: experiment.status,
          liveRunId: experiment.liveRunId,
        })
      : null,
    run: run
      ? RunConfigKVSchema.parse({
          id: run.id,
          experimentId: run.experimentId,
          salt: run.salt,
          allocation: JSON.parse(run.allocation) as Record<string, number>,
          variantSet: JSON.parse(run.variantSet) as Variant[],
          targetingRules: JSON.parse(run.targetingRules) as TargetingRule[],
          configHash: run.configHash,
          startedAt: run.startedAt,
        })
      : null,
    version: config.version,
  };
}

async function writeSnapshot(kv: KVNamespace, scope: EnvScope, snapshot: Snapshot): Promise<void> {
  await kv.put(
    flagConfigKey(scope.appId, scope.environmentId, snapshot.flag.key),
    envelope(FlagConfigEnvelope, snapshot.flag),
  );
  if (snapshot.experiment) {
    await kv.put(
      experimentConfigKey(scope.appId, scope.environmentId, snapshot.experiment.id),
      envelope(ExperimentConfigEnvelope, snapshot.experiment),
    );
  }
  if (snapshot.run) {
    await kv.put(
      runConfigKey(scope.appId, scope.environmentId, snapshot.run.id),
      envelope(RunConfigEnvelope, snapshot.run),
    );
    await kv.put(
      liveRunKey(scope.appId, scope.environmentId),
      envelope(LiveRunEnvelope, {
        runId: snapshot.run.id,
      }),
    );
  }
}

function responseFromSnapshot(snapshot: Snapshot): FlagConfigResult {
  return {
    flagId: snapshot.flag.id,
    environmentId: snapshot.flag.environmentId,
    version: snapshot.version,
    enabled: snapshot.flag.enabled,
    availableVariantNames: snapshot.flag.availableVariantNames,
    targetingRules: snapshot.flag.targetingRules,
  };
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

function missingAvailableVariants(names: string[] | undefined, variants: Variant[]): string[] {
  if (!names) return [];
  const catalog = new Set(variants.map((variant) => variant.name));
  return names.filter((name) => !catalog.has(name));
}

function requiredString(value: string | null, name: string): string {
  if (!value) throw new Error(`config-store: missing ${name}`);
  return value;
}

function envelope<T>(schema: ReturnType<typeof kvEnvelope>, data: T): string {
  return JSON.stringify(schema.parse({ schemaVersion: CURRENT_KV_SCHEMA_VERSION, data }));
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

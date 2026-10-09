import {
  DeltaNudgeSchema,
  flagConfigKey,
  type TargetingRule,
  type Variant,
} from "@splitch/contracts";
import { appScope, type EnvScope } from "@splitch/db";
import { parseFlagConfigEnvelope, writeSnapshot } from "./config-store-kv";
import { buildSnapshotFromD1 } from "./config-store-snapshot-build";
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

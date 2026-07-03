import type { TargetingRule, Variant } from "@splitch/contracts";
import { envScope, type EnvScope } from "@splitch/db";
import { randomHex } from "./credential-cache.js";
import {
  buildSnapshotFromD1,
  json,
  missingAvailableVariants,
  missingRuleVariantNames,
  responseFromSnapshot,
  targetingRuleRows,
  writeSnapshotAndBroadcast,
  type ConfigStoreDeps,
  type FlagConfigWriteResult,
  type PromoteFlagConfigInput,
  type PromoteFlagConfigResult,
  type ReplaceTargetingRulesInput,
  type Snapshot,
} from "./config-store-shared.js";

export async function replaceTargetingRules(
  deps: ConfigStoreDeps,
  input: ReplaceTargetingRulesInput,
): Promise<FlagConfigWriteResult> {
  const scope = envScope(input.appId, input.environmentId);
  const snapshot = await buildSnapshotFromD1(deps.repo, scope, input.flagId);
  if (!snapshot) return { ok: false, reason: "FLAG_NOT_FOUND" };

  const missingVariants = missingRuleVariantNames(
    input.targetingRules,
    snapshot.flag.variants,
    snapshot.flag.availableVariantNames,
  );
  if (missingVariants.length > 0) {
    return { ok: false, reason: "VARIANT_NOT_AVAILABLE", missingVariants };
  }

  return commitTargetingRules(deps, scope, input.flagId, input.targetingRules);
}

export async function promoteFlagConfig(
  deps: ConfigStoreDeps,
  input: PromoteFlagConfigInput,
): Promise<PromoteFlagConfigResult> {
  const loaded = await loadPromotionSnapshots(deps, input);
  if (!loaded.ok) return loaded;

  const prepared = preparePromotion(input, loaded.source, loaded.target);
  if (!prepared.ok) return prepared;

  const write = await commitPromotion(deps, input, loaded.targetScope, prepared.value);
  if (!write.ok) return write;

  return {
    ok: true,
    config: write.config,
    diff: { before: responseFromSnapshot(loaded.target), after: write.config },
    nudge: write.nudge,
  };
}

async function commitTargetingRules(
  deps: ConfigStoreDeps,
  scope: EnvScope,
  flagId: string,
  targetingRules: TargetingRule[],
): Promise<FlagConfigWriteResult> {
  const now = deps.now?.() ?? new Date();
  const replaced = await deps.repo.flags.replaceTargetingRules(
    scope,
    flagId,
    targetingRuleRows(targetingRules, now),
    { updatedAt: now.toISOString() },
  );
  if (!replaced) return { ok: false, reason: "FLAG_NOT_FOUND" };

  const committed = await buildSnapshotFromD1(deps.repo, scope, flagId);
  if (!committed) return { ok: false, reason: "FLAG_NOT_FOUND" };
  return writeSnapshotAndBroadcast(deps, scope, flagId, committed);
}

async function loadPromotionSnapshots(deps: ConfigStoreDeps, input: PromoteFlagConfigInput) {
  const targetScope = envScope(input.appId, input.targetEnvironmentId);
  const sourceScope = envScope(input.appId, input.fromEnvironmentId);
  const source = await buildSnapshotFromD1(deps.repo, sourceScope, input.flagId);
  const target = await buildSnapshotFromD1(deps.repo, targetScope, input.flagId);
  if (!source || !target) return { ok: false as const, reason: "FLAG_NOT_FOUND" as const };
  return { ok: true as const, source, target, targetScope };
}

function preparePromotion(
  input: PromoteFlagConfigInput,
  source: Snapshot,
  target: Snapshot,
):
  | {
      ok: true;
      value: { availableVariantNames: string[]; enabled: boolean; targetingRules: TargetingRule[] };
    }
  | { ok: false; reason: "VARIANT_NOT_AVAILABLE"; missingVariants: string[] } {
  const selectedAvailability = input.select.availability;
  const missingSelectedVariants = missingAvailableVariants(
    selectedAvailability,
    target.flag.variants,
  );
  if (missingSelectedVariants.length > 0) {
    return {
      ok: false,
      reason: "VARIANT_NOT_AVAILABLE",
      missingVariants: missingSelectedVariants,
    };
  }

  const availableVariantNames =
    selectedAvailability === undefined
      ? target.flag.availableVariantNames
      : copySelectedAvailability(
          target.flag.availableVariantNames,
          source.flag.availableVariantNames,
          selectedAvailability,
          target.flag.variants,
        );
  const selectedTargetingRules = input.select.targeting
    ? promotedTargetingRules(source.flag.targetingRules)
    : target.flag.targetingRules;
  const targetingRules = input.select.rollout
    ? promotedRollouts(source.flag.targetingRules, selectedTargetingRules)
    : selectedTargetingRules;
  const missingRuleVariants = missingRuleVariantNames(
    targetingRules,
    target.flag.variants,
    availableVariantNames,
  );
  if (missingRuleVariants.length > 0) {
    return { ok: false, reason: "VARIANT_NOT_AVAILABLE", missingVariants: missingRuleVariants };
  }
  return {
    ok: true,
    value: { availableVariantNames, enabled: source.flag.enabled, targetingRules },
  };
}

async function commitPromotion(
  deps: ConfigStoreDeps,
  input: PromoteFlagConfigInput,
  targetScope: EnvScope,
  prepared: { availableVariantNames: string[]; enabled: boolean; targetingRules: TargetingRule[] },
): Promise<FlagConfigWriteResult> {
  const now = deps.now?.() ?? new Date();
  const configPatch = {
    ...(input.select.availability !== undefined
      ? { availableVariantNames: json(prepared.availableVariantNames) }
      : {}),
    ...(input.select.enabled ? { enabled: prepared.enabled } : {}),
    updatedAt: now.toISOString(),
  };
  if (input.select.targeting || input.select.rollout) {
    const replaced = await deps.repo.flags.replaceTargetingRules(
      targetScope,
      input.flagId,
      targetingRuleRows(prepared.targetingRules, now),
      configPatch,
    );
    if (!replaced) return { ok: false, reason: "FLAG_NOT_FOUND" };
  } else if (!(await deps.repo.flags.updateFlagConfig(targetScope, input.flagId, configPatch))) {
    return { ok: false, reason: "FLAG_NOT_FOUND" };
  }

  const committed = await buildSnapshotFromD1(deps.repo, targetScope, input.flagId);
  if (!committed) return { ok: false, reason: "FLAG_NOT_FOUND" };
  return writeSnapshotAndBroadcast(deps, targetScope, input.flagId, committed);
}

function copySelectedAvailability(
  targetAvailableVariantNames: string[],
  sourceAvailableVariantNames: string[],
  selectedVariantNames: string[],
  variants: Variant[],
): string[] {
  const next = new Set(targetAvailableVariantNames);
  const source = new Set(sourceAvailableVariantNames);
  for (const name of selectedVariantNames) {
    if (source.has(name)) {
      next.add(name);
    } else {
      next.delete(name);
    }
  }
  return variants.map((variant) => variant.name).filter((name) => next.has(name));
}

function promotedTargetingRules(rules: TargetingRule[]): TargetingRule[] {
  return rules.map((rule) => ({
    ...rule,
    id: `rule_${randomHex(12)}`,
  }));
}

function promotedRollouts(
  sourceRules: TargetingRule[],
  targetRules: TargetingRule[],
): TargetingRule[] {
  const rolloutsByPriority = new Map(
    sourceRules.map((rule) => [rule.priority, rule.percentageRollout ?? null]),
  );
  return targetRules.map((rule) => {
    if (!rolloutsByPriority.has(rule.priority)) return rule;
    return { ...rule, percentageRollout: rolloutsByPriority.get(rule.priority) ?? null };
  });
}

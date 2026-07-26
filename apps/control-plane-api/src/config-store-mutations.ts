import type { PercentageRollout, TargetingRule, Variant } from "@splitch/contracts";
import { envScope, type EnvScope } from "@splitch/db";
import { randomHex } from "./credential-cache";
import { baselineIsUnresolvable, mintSalt } from "./flag-config-rollout";
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
} from "./config-store-shared";

interface PreparedPromotion {
  availableVariantNames: string[];
  enabled: boolean;
  targetingRules: TargetingRule[];
  /** `undefined` = the baseline was not selected, so leave the target's alone. */
  rollout: PercentageRollout | null | undefined;
}

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
  | { ok: true; value: PreparedPromotion }
  | { ok: false; reason: "VARIANT_NOT_AVAILABLE"; missingVariants: string[] }
  | { ok: false; reason: "ROLLOUT_AMBIGUOUS"; availableVariantNames: string[] } {
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

  const availableVariantNames = promotedAvailability(selectedAvailability, source, target);
  const targetingRules = promotedRules(input, source, target);
  const missingRuleVariants = missingRuleVariantNames(
    targetingRules,
    target.flag.variants,
    availableVariantNames,
  );
  if (missingRuleVariants.length > 0) {
    return { ok: false, reason: "VARIANT_NOT_AVAILABLE", missingVariants: missingRuleVariants };
  }

  const rollout = input.select.rollout
    ? promotedBaselineRollout(source.flag.rollout, target.flag.rollout)
    : undefined;
  // Checked against the state this Promotion LANDS. `select.availability` alone
  // can strand the target's existing baseline, so an unselected `rollout` still
  // has to be judged against the availability that is about to replace it.
  const landedRollout = rollout === undefined ? target.flag.rollout : rollout;
  const defaultVariant = target.flag.variants.find(
    (variant) => variant.id === target.flag.defaultVariantId,
  );
  if (
    baselineIsUnresolvable(
      landedRollout,
      availableVariantNames,
      defaultVariant?.name,
      target.flag.variants.map((variant) => variant.name),
    )
  ) {
    return { ok: false, reason: "ROLLOUT_AMBIGUOUS", availableVariantNames };
  }

  return {
    ok: true,
    value: {
      availableVariantNames,
      enabled: source.flag.enabled,
      targetingRules,
      rollout,
    },
  };
}

function promotedAvailability(
  selectedAvailability: string[] | undefined,
  source: Snapshot,
  target: Snapshot,
): string[] {
  if (selectedAvailability === undefined) return target.flag.availableVariantNames;
  return copySelectedAvailability(
    target.flag.availableVariantNames,
    source.flag.availableVariantNames,
    selectedAvailability,
    target.flag.variants,
  );
}

/**
 * Targeting Rules move only under `select.targeting`, and they move WHOLE:
 * conditions and `percentageRollout` together, because a percentage is the split
 * of one rule's matched traffic and means nothing apart from that rule.
 *
 * `select.rollout` therefore means exactly one thing — the config-level baseline.
 * It used to ALSO graft each source rule's percentage onto the target rule with
 * the same `priority`, but `priority` is a sort key, not an identity: Dev and
 * Prod rule lists are routinely out of sync (that is what promotion is for), so
 * that matched unrelated rules and silently wrote the wrong percentage onto them.
 */
function promotedRules(
  input: PromoteFlagConfigInput,
  source: Snapshot,
  target: Snapshot,
): TargetingRule[] {
  return input.select.targeting
    ? promotedTargetingRules(source.flag.targetingRules)
    : target.flag.targetingRules;
}

/**
 * Promotion moves the source's baseline PERCENTAGE, never its salt: the target
 * Environment's cohort is its own, and adopting the source salt would reshuffle
 * every bucketed Entity in the target. The target keeps its salt if it already
 * has one and mints a fresh one only when it had no baseline at all.
 */
function promotedBaselineRollout(
  source: PercentageRollout | null,
  target: PercentageRollout | null,
): PercentageRollout | null {
  if (source === null) return null;
  return { percentage: source.percentage, salt: target?.salt ?? mintSalt() };
}

function promotionConfigPatch(
  input: PromoteFlagConfigInput,
  prepared: PreparedPromotion,
  now: Date,
) {
  return {
    ...(input.select.availability !== undefined
      ? { availableVariantNames: json(prepared.availableVariantNames) }
      : {}),
    ...(input.select.enabled ? { enabled: prepared.enabled } : {}),
    ...(prepared.rollout !== undefined
      ? { rollout: prepared.rollout === null ? null : json(prepared.rollout) }
      : {}),
    updatedAt: now.toISOString(),
  };
}

async function commitPromotion(
  deps: ConfigStoreDeps,
  input: PromoteFlagConfigInput,
  targetScope: EnvScope,
  prepared: PreparedPromotion,
): Promise<FlagConfigWriteResult> {
  const now = deps.now?.() ?? new Date();
  const configPatch = promotionConfigPatch(input, prepared, now);
  // Only `select.targeting` moves rules. Since SPL-170 `select.rollout` means the
  // config-level baseline, which lives on flag_configs — routing it through
  // replaceTargetingRules (a DELETE + re-INSERT) would re-stamp `createdAt` on
  // every rule the caller never touched, destroying their creation history.
  if (input.select.targeting) {
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

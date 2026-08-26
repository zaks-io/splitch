import type { PercentageRollout, TargetingRule, Variant } from "@splitch/contracts";
import { type EnvScope, envScope } from "@splitch/db";
import { promotionFreeze } from "./config-store-freeze";
import {
  buildSnapshotFromD1,
  type ConfigStoreDeps,
  type FlagConfigWriteResult,
  flagConfigResult,
  json,
  missingAvailableVariants,
  missingRuleVariantNames,
  type PromoteFlagConfigInput,
  type PromoteFlagConfigResult,
  responseFromSnapshot,
  type Snapshot,
  targetingRuleRows,
  writeSnapshotAndBroadcast,
} from "./config-store-shared";
import { targetingRulePersistFailure } from "./config-store-targeting-rules";
import { randomHex } from "./credential-cache";
import { baselineIsUnresolvable, mintSalt } from "./flag-config-rollout";
import { SegmentNotFoundError } from "./targeting-rule-resolution";

interface PreparedPromotion {
  availableVariantNames: string[];
  enabled: boolean;
  targetingRules: TargetingRule[];
  /** `undefined` = the baseline was not selected, so leave the target's alone. */
  rollout: PercentageRollout | null | undefined;
}

export async function promoteFlagConfig(
  deps: ConfigStoreDeps,
  input: PromoteFlagConfigInput,
): Promise<PromoteFlagConfigResult> {
  // Covers the preview too, and deliberately: `previewPromotion` is what the
  // Policy gate turns into an Approval Request, so refusing here is what stops a
  // frozen Promotion from being parked as a pending proposal.
  const frozen = await promotionFreeze(deps, input);
  if (frozen) return frozen;

  let loaded: Awaited<ReturnType<typeof loadPromotionSnapshots>>;
  try {
    loaded = await loadPromotionSnapshots(deps, input);
  } catch (cause) {
    if (cause instanceof SegmentNotFoundError) {
      return {
        ok: false,
        reason: "SEGMENT_NOT_FOUND",
        missingSegmentIds: cause.missingSegmentIds,
      };
    }
    throw cause;
  }
  if (!loaded.ok) return loaded;

  const prepared = preparePromotion(input, loaded.source, loaded.target);
  if (!prepared.ok) return prepared;

  if (input.preview) return promotionPreview(input, loaded.target, prepared.value);

  const write = await commitPromotion(deps, input, loaded.targetScope, prepared.value);
  if (!write.ok) return write;

  return {
    ok: true,
    config: write.config,
    diff: { before: responseFromSnapshot(loaded.target), after: write.config },
    nudge: write.nudge,
  };
}

function promotionPreview(
  input: PromoteFlagConfigInput,
  target: Snapshot,
  prepared: PreparedPromotion,
): PromoteFlagConfigResult {
  const before = responseFromSnapshot(target);
  const after = {
    ...before,
    // A preview that promises a version bump the commit will not perform is a
    // lie the caller plans against.
    version: promotionSelectsNothing(input) ? before.version : before.version + 1,
    availableVariantNames: prepared.availableVariantNames,
    enabled: input.select.enabled ? prepared.enabled : before.enabled,
    targetingRules: prepared.targetingRules,
    rollout: prepared.rollout === undefined ? before.rollout : prepared.rollout,
  };
  return {
    ok: true,
    config: after,
    diff: { before, after },
    nudge: { type: "config.changed", entity: "flag", id: input.flagId, version: after.version },
  };
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
    ? promotedBaselineRollout(
        source.flag.rollout,
        target.flag.rollout,
        input.approvalRolloutSalt ? () => input.approvalRolloutSalt as string : undefined,
      )
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
    ? promotedTargetingRules(source.authoringTargetingRules)
    : target.authoringTargetingRules;
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
  freshSalt = mintSalt,
): PercentageRollout | null {
  if (source === null) return null;
  return { percentage: source.percentage, salt: target?.salt ?? freshSalt() };
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
    updatedBy: input.actor.ref,
    updatedVia: input.actor.via,
  };
}

/**
 * `select: {}` moves no field group, so the only patch left is `updatedAt` — and
 * writing that still bumps `flag_configs.version`, which is the concurrency token
 * every pending Approval Request on that Flag Configuration holds. A caller who
 * changed nothing would invalidate a proposal someone else is waiting to have
 * reviewed. A no-op write is a no-op.
 *
 * Only on the ungated path. Under `approval` the D1 write is also what records
 * the Review as landed, so short-circuiting it would strand the Review as
 * un-applied — a Policy gate never produces this shape anyway, since an empty
 * selection yields no change types to gate.
 */
function promotionSelectsNothing(input: PromoteFlagConfigInput): boolean {
  if (input.approval) return false;
  return (
    input.select.availability === undefined &&
    !input.select.enabled &&
    !input.select.rollout &&
    !input.select.targeting
  );
}

async function commitPromotion(
  deps: ConfigStoreDeps,
  input: PromoteFlagConfigInput,
  targetScope: EnvScope,
  prepared: PreparedPromotion,
): Promise<FlagConfigWriteResult> {
  const now = input.approval ? new Date(input.approval.reviewedAt) : (deps.now?.() ?? new Date());
  if (promotionSelectsNothing(input)) {
    const current = await buildSnapshotFromD1(deps.repo, targetScope, input.flagId);
    if (!current) return { ok: false, reason: "FLAG_NOT_FOUND" };
    return flagConfigResult(input.flagId, current);
  }
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
      input.approval,
    );
    if (!replaced.ok) {
      return targetingRulePersistFailure(replaced, prepared.targetingRules, "FLAG_NOT_FOUND");
    }
  } else if (
    !(await deps.repo.flags.updateFlagConfig(
      targetScope,
      input.flagId,
      configPatch,
      input.approval,
    ))
  ) {
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

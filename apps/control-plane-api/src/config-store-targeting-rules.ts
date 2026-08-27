import type { TargetingRule } from "@splitch/contracts";
import { type EnvScope, envScope, type ReplaceTargetingRulesResult } from "@splitch/db";
import { targetingFreeze } from "./config-store-freeze";
import {
  buildSnapshotFromD1,
  type ConfigStoreDeps,
  type FlagConfigWriteResult,
  loadFlagConfigWriteContext,
  missingRuleVariantNames,
  type ReplaceTargetingRulesInput,
  targetingRuleRows,
  toTargetingRule,
  writeSnapshotAndBroadcast,
} from "./config-store-shared";
import { normalizeTargetingRuleRollouts } from "./flag-config-rollout";
import { resolveTargetingRules } from "./targeting-rule-resolution";

/**
 * Persist uniqueness races stay typed. A missing row is caller-specific:
 * direct/Promotion writes treat it as FLAG_NOT_FOUND; an approved write must
 * not claim the Flag vanished when the Approval guard simply selected zero.
 */
export function targetingRulePersistFailure(
  result: Extract<ReplaceTargetingRulesResult, { ok: false }>,
  targetingRules: TargetingRule[],
  missingReason: "FLAG_NOT_FOUND" | "APPROVAL_NOT_APPLIED",
): Extract<FlagConfigWriteResult, { ok: false }> {
  switch (result.reason) {
    case "id_conflict":
      return { ok: false, reason: "TARGETING_RULE_ID_CONFLICT", targetingRules };
    case "missing_variant":
      return {
        ok: false,
        reason: "VARIANT_NOT_AVAILABLE",
        missingVariants: result.missingVariantIds,
      };
    case "not_found":
      return { ok: false, reason: missingReason };
    default: {
      const _exhaustive: never = result;
      return _exhaustive;
    }
  }
}

export async function replaceTargetingRules(
  deps: ConfigStoreDeps,
  input: ReplaceTargetingRulesInput,
): Promise<FlagConfigWriteResult> {
  const frozen = await targetingFreeze(deps, input);
  if (frozen) return frozen;

  const scope = envScope(input.appId, input.environmentId);
  const [context, currentRows] = await Promise.all([
    loadFlagConfigWriteContext(deps.repo, scope, input.flagId),
    deps.repo.flags.listTargetingRules(scope, input.flagId),
  ]);
  if (!context) return { ok: false, reason: "FLAG_NOT_FOUND" };
  const currentTargetingRules = currentRows.map(toTargetingRule);
  const normalized = normalizeTargetingRuleRollouts(currentTargetingRules, input.targetingRules);
  if (!normalized.ok) {
    return {
      ok: false,
      reason: "TARGETING_RULE_SALT_REJECTED",
      callerSaltIndexes: normalized.callerSaltIndexes,
    };
  }

  const missingVariants = missingRuleVariantNames(
    normalized.targetingRules,
    context.variants,
    JSON.parse(context.config.availableVariantNames) as string[],
  );
  if (missingVariants.length > 0) {
    return { ok: false, reason: "VARIANT_NOT_AVAILABLE", missingVariants };
  }

  const resolved = await resolveTargetingRules(deps.repo, input.appId, normalized.targetingRules);
  if (!resolved.ok) {
    return {
      ok: false,
      reason: "SEGMENT_NOT_FOUND",
      missingSegmentIds: resolved.missingSegmentIds,
    };
  }

  return commitTargetingRules(deps, scope, {
    ...input,
    targetingRules: normalized.targetingRules,
  });
}

async function commitTargetingRules(
  deps: ConfigStoreDeps,
  scope: EnvScope,
  input: ReplaceTargetingRulesInput & { targetingRules: TargetingRule[] },
): Promise<FlagConfigWriteResult> {
  const { approval, flagId } = input;
  const now = approval ? new Date(approval.reviewedAt) : (deps.now?.() ?? new Date());
  // The rule rewrite also bumps the owning Flag Configuration, so the actor lands
  // on `flag_configs` and the audit trigger can attribute the targeting change.
  const replaced = await deps.repo.flags.replaceTargetingRules(
    scope,
    flagId,
    targetingRuleRows(input.targetingRules, now),
    { updatedAt: now.toISOString(), updatedBy: input.actor.ref, updatedVia: input.actor.via },
    approval,
  );
  if (!replaced.ok) {
    return targetingRulePersistFailure(replaced, input.targetingRules, "FLAG_NOT_FOUND");
  }

  const committed = await buildSnapshotFromD1(deps.repo, scope, flagId);
  if (!committed) return { ok: false, reason: "FLAG_NOT_FOUND" };
  return writeSnapshotAndBroadcast(deps, scope, flagId, committed);
}

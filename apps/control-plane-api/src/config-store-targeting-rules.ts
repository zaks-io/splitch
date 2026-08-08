import type { TargetingRule } from "@splitch/contracts";
import { type EnvScope, envScope } from "@splitch/db";
import { targetingFreeze } from "./config-store-freeze";
import {
  buildSnapshotFromD1,
  type ConfigStoreDeps,
  type FlagConfigWriteResult,
  loadFlagConfigWriteContext,
  missingRuleVariantNames,
  type ReplaceTargetingRulesInput,
  targetingRuleRows,
  writeSnapshotAndBroadcast,
} from "./config-store-shared";
import { resolveTargetingRules } from "./targeting-rule-resolution";

export async function replaceTargetingRules(
  deps: ConfigStoreDeps,
  input: ReplaceTargetingRulesInput,
): Promise<FlagConfigWriteResult> {
  const frozen = await targetingFreeze(deps, input);
  if (frozen) return frozen;

  const scope = envScope(input.appId, input.environmentId);
  const context = await loadFlagConfigWriteContext(deps.repo, scope, input.flagId);
  if (!context) return { ok: false, reason: "FLAG_NOT_FOUND" };

  const missingVariants = missingRuleVariantNames(
    input.targetingRules,
    context.variants,
    JSON.parse(context.config.availableVariantNames) as string[],
  );
  if (missingVariants.length > 0) {
    return { ok: false, reason: "VARIANT_NOT_AVAILABLE", missingVariants };
  }

  const resolved = await resolveTargetingRules(deps.repo, input.appId, input.targetingRules);
  if (!resolved.ok) {
    return {
      ok: false,
      reason: "SEGMENT_NOT_FOUND",
      missingSegmentIds: resolved.missingSegmentIds,
    };
  }

  return commitTargetingRules(deps, scope, input.flagId, input.targetingRules, input.approval);
}

async function commitTargetingRules(
  deps: ConfigStoreDeps,
  scope: EnvScope,
  flagId: string,
  targetingRules: TargetingRule[],
  approval?: ReplaceTargetingRulesInput["approval"],
): Promise<FlagConfigWriteResult> {
  const now = approval ? new Date(approval.reviewedAt) : (deps.now?.() ?? new Date());
  const replaced = await deps.repo.flags.replaceTargetingRules(
    scope,
    flagId,
    targetingRuleRows(targetingRules, now),
    { updatedAt: now.toISOString() },
    approval,
  );
  if (!replaced) return { ok: false, reason: "FLAG_NOT_FOUND" };

  const committed = await buildSnapshotFromD1(deps.repo, scope, flagId);
  if (!committed) return { ok: false, reason: "FLAG_NOT_FOUND" };
  return writeSnapshotAndBroadcast(deps, scope, flagId, committed);
}

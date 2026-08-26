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

  return commitTargetingRules(deps, scope, input);
}

async function commitTargetingRules(
  deps: ConfigStoreDeps,
  scope: EnvScope,
  input: ReplaceTargetingRulesInput,
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
  if (!replaced) return { ok: false, reason: "FLAG_NOT_FOUND" };

  const committed = await buildSnapshotFromD1(deps.repo, scope, flagId);
  if (!committed) return { ok: false, reason: "FLAG_NOT_FOUND" };
  return writeSnapshotAndBroadcast(deps, scope, flagId, committed);
}

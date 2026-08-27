import { DeltaNudgeSchema, type TargetingRule } from "@splitch/contracts";
import { envScope } from "@splitch/db";
import { targetingFreeze } from "./config-store-freeze";
import {
  buildSnapshotFromD1,
  type ConfigStoreDeps,
  type FlagConfigWriteResult,
  missingRuleVariantNames,
  type ReplaceTargetingRulesInput,
  responseFromSnapshot,
  type Snapshot,
} from "./config-store-shared";
import { normalizeTargetingRuleRollouts } from "./flag-config-rollout";
import { resolveTargetingRules } from "./targeting-rule-resolution";

export async function previewTargetingRules(
  deps: ConfigStoreDeps,
  input: ReplaceTargetingRulesInput,
): Promise<FlagConfigWriteResult> {
  const frozen = await targetingFreeze(deps, input);
  if (frozen) return frozen;

  const scope = envScope(input.appId, input.environmentId);
  const snapshot = await buildSnapshotFromD1(deps.repo, scope, input.flagId);
  if (!snapshot) return { ok: false, reason: "FLAG_NOT_FOUND" };
  const normalized = normalizeTargetingRuleRollouts(
    snapshot.authoringTargetingRules,
    input.targetingRules,
  );
  if (!normalized.ok) {
    return {
      ok: false,
      reason: "TARGETING_RULE_SALT_REJECTED",
      callerSaltIndexes: normalized.callerSaltIndexes,
    };
  }
  const missingVariants = missingRuleVariantNames(
    normalized.targetingRules,
    snapshot.flag.variants,
    snapshot.flag.availableVariantNames,
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
  return previewSnapshotResult(
    snapshot,
    { targetingRules: resolved.rules },
    normalized.targetingRules,
  );
}

export function previewSnapshotResult(
  current: Snapshot,
  patch: Partial<
    Pick<Snapshot["flag"], "enabled" | "availableVariantNames" | "targetingRules" | "rollout">
  >,
  authoringTargetingRules?: TargetingRule[],
): FlagConfigWriteResult {
  const proposed: Snapshot = {
    ...current,
    version: current.version + 1,
    flag: {
      ...current.flag,
      ...patch,
    },
    ...(authoringTargetingRules ? { authoringTargetingRules } : {}),
  };
  return {
    ok: true,
    config: responseFromSnapshot(proposed),
    nudge: DeltaNudgeSchema.parse({
      type: "config.changed",
      entity: "flag",
      id: current.flag.id,
      version: proposed.version,
    }),
  };
}

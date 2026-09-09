import {
  type ApprovalPolicyContext,
  canonicalJson,
  type PolicyChangeType,
} from "@splitch/contracts";
import type { FlagConfigResult } from "./config-store-types";

export function winnerChangedFields(
  current: FlagConfigResult,
  proposed: FlagConfigResult,
): PolicyChangeType[] {
  const changes: PolicyChangeType[] = [];
  if (
    canonicalJson(current.availableVariantNames) !== canonicalJson(proposed.availableVariantNames)
  ) {
    changes.push("variant_availability");
  }
  if (
    canonicalJson(current.targetingRules) !== canonicalJson(proposed.targetingRules) ||
    canonicalJson(current.rollout) !== canonicalJson(proposed.rollout)
  ) {
    changes.push("targeting_rollout_value");
  }
  if (current.enabled !== proposed.enabled) changes.push("enabled_state");
  return changes;
}

export function winnerConfirmFloor(contexts: ApprovalPolicyContext[]): ApprovalPolicyContext[] {
  return contexts.map((context) => ({
    ...context,
    level: context.level === "allow" ? "confirm" : context.level,
  }));
}

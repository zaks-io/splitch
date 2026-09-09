import type { TargetingRuleInput } from "@splitch/contracts";
import type { TargetingEdit } from "./flag-edit-intent";

/** Build the complete proposed rule list while retaining persisted salts on untouched rules. */
export function applyTargetingEdit(
  rules: readonly TargetingRuleInput[],
  edit: TargetingEdit,
  flagId: string,
): TargetingRuleInput[] {
  if (edit.kind === "remove") return rules.filter((rule) => rule.id !== edit.ruleId);
  const priority = rules.reduce((highest, rule) => Math.max(highest, rule.priority), -1) + 1;
  return [
    ...rules,
    {
      id: edit.ruleId,
      flagId,
      priority,
      conditions: edit.condition ? [edit.condition] : [],
      ...(edit.segmentId ? { segmentId: edit.segmentId } : {}),
      variantId: edit.variantId,
      percentageRollout: edit.percentage === undefined ? null : { percentage: edit.percentage },
    },
  ];
}

import { FlagTargetingRulesEditor } from "#components/flags/flag-targeting-rules-editor";
import type {
  ConclusionDraft,
  ConclusionTarget,
} from "#lib/experiments/experiment-conclusion-model";
import { parseConclusionTargetingRules } from "#lib/experiments/experiment-conclusion-targeting";
import { applyTargetingEdit } from "#lib/flags/apply-targeting-edit";
import { targetingRuleViews } from "#lib/flags/flag-detail-view";

export function ExperimentConclusionTargeting({
  draft,
  target,
  update,
  disabled,
}: {
  draft: ConclusionDraft;
  target: ConclusionTarget;
  update: (patch: Partial<ConclusionDraft>) => void;
  disabled: boolean;
}) {
  const rules = parseConclusionTargetingRules(draft.targetingRulesJson);
  const targetingRules = targetingRuleViews(rules, target.variants, target.segments);
  return (
    <FlagTargetingRulesEditor
      editing={{
        busy: disabled,
        submit: async (intent) => {
          const next = applyTargetingEdit(rules, intent.edit, target.flagId);
          update({ targetingRulesJson: JSON.stringify(next, null, 2) });
        },
      }}
      view={{ catalog: target.variants, targetingRules, segments: target.segments }}
    />
  );
}

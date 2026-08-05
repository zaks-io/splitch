import type {
  PanelExperimentDetailOutput,
  PanelExperimentRun,
} from "@splitch/control-plane-sdk/panel-experiments";
import { useState } from "react";
import { initialRunDraft, runDraftErrors } from "./experiment-run-draft-model";
import type { RunStartDraft } from "./use-experiment-run-start";

/**
 * The editable Run draft plus its per-field verdicts, shared by the next-Run
 * dialog and the Experiment-creation flow's Run 1 step so both forms agree on
 * what "incomplete" means. `isInvalid` is the same predicate the Worker will
 * apply, so the Panel refuses locally for the same reasons and never presents a
 * Start button that is guaranteed to 400.
 */
export function useRunDraftState(
  data: PanelExperimentDetailOutput,
  baseRun: PanelExperimentRun | undefined,
) {
  const [draft, setDraft] = useState<RunStartDraft>(() => initialRunDraft(data, baseRun));
  const errors = runDraftErrors(draft);
  return {
    draft,
    errors,
    isInvalid: Object.values(errors).some((message) => message !== null),
    setAllocationShare(variant: string, share: number) {
      setDraft((current) => ({
        ...current,
        allocation: { ...current.allocation, [variant]: share },
      }));
    },
    update(patch: Partial<RunStartDraft>) {
      setDraft((current) => ({ ...current, ...patch }));
    },
  };
}

export type RunDraftState = ReturnType<typeof useRunDraftState>;

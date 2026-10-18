import { EmptyState } from "@splitch/ui/state/empty-state";
import {
  TEMPORARY_ENVIRONMENT_EXPERIMENT_REASON,
  TemporaryEnvironmentExperimentAction,
} from "#components/experiments/temporary-environment-experiment-action";
import { PanelPageBody } from "#components/shell/panel-page-body";

export function TemporaryEnvironmentExperiments() {
  return (
    <PanelPageBody>
      <EmptyState
        action={
          <TemporaryEnvironmentExperimentAction describedBy="temporary-experiments-reason">
            New Experiment
          </TemporaryEnvironmentExperimentAction>
        }
        description={
          <span id="temporary-experiments-reason">{TEMPORARY_ENVIRONMENT_EXPERIMENT_REASON}</span>
        }
        title="Experiments unavailable"
      />
    </PanelPageBody>
  );
}

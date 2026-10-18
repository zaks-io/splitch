import { Button } from "@splitch/ui/components/button";
import { EmptyState } from "@splitch/ui/state/empty-state";
import { PanelPageBody } from "#components/shell/panel-page-body";

export function TemporaryEnvironmentExperiments() {
  return (
    <PanelPageBody>
      <EmptyState
        action={
          <Button disabled aria-describedby="temporary-experiments-reason">
            New Experiment
          </Button>
        }
        description={
          <span id="temporary-experiments-reason">
            Experiment creation is unavailable because a Temporary Environment cannot host
            Experiments.
          </span>
        }
        title="Experiments unavailable"
      />
    </PanelPageBody>
  );
}

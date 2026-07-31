import type { PanelExperimentDetailOutput } from "@splitch/control-plane-sdk/panel-experiments";
import { Alert, AlertDescription, AlertTitle } from "@splitch/ui/components/alert";
import { Button } from "@splitch/ui/components/button";
import { Dialog, DialogContent, DialogTrigger } from "@splitch/ui/components/dialog";
import { useState } from "react";
import { useRunDraftState } from "#lib/experiment-run-draft-state";
import { useExperimentRunStart } from "#lib/use-experiment-run-start";
import { ExperimentRunDraftFields } from "./experiment-run-draft-fields";
import { ExperimentRunStartConfirmation } from "./experiment-run-start-confirmation";

/**
 * The final creation step. It opens Run 1 through the SAME machinery every later
 * Run uses: the shared draft fields, the shared Start confirmation, and
 * `useExperimentRunStart` — which is the Panel's only caller of
 * `stageAndStartControlPanelExperimentRun`. There is deliberately no
 * creation-only start path.
 */
export function ExperimentDraftRunStep({
  data,
  onStarted,
  scope,
}: {
  data: PanelExperimentDetailOutput;
  onStarted: () => void;
  scope: { appId: string; environmentId: string };
}) {
  // Derived, never assumed to be 1: an Experiment returns to `draft` when its Run
  // ends, so this step is reachable with Runs already on the record, and the
  // Start confirmation must name the number the Control Plane will assign.
  const baseRun = data.runs[0];
  const nextRunNumber = data.runs.reduce((max, run) => Math.max(max, run.runNumber), 0) + 1;
  const state = useRunDraftState(data, baseRun);
  const [confirming, setConfirming] = useState(false);
  const start = useExperimentRunStart({
    appId: scope.appId,
    environmentId: scope.environmentId,
    experimentId: data.experiment.id,
    onStarted,
  });
  const missingGoalMetric = data.experiment.metricIds.length === 0;

  return (
    <div className="flex flex-col gap-4">
      {missingGoalMetric ? (
        <Alert data-testid="draft-not-startable" variant="destructive">
          <AlertTitle>Run {nextRunNumber} cannot Start yet</AlertTitle>
          <AlertDescription>
            This Experiment has no goal Metric. Start freezes the goal Metric family into the Run
            and every later addition is exploratory, so choose one on the Metrics step first.
          </AlertDescription>
        </Alert>
      ) : null}
      <ExperimentRunDraftFields
        data={data}
        hasRunningRun={data.experiment.liveRunId !== null}
        idPrefix="run-one"
        state={state}
      />
      {start.error ? (
        <Alert data-testid="run-start-error" variant="destructive">
          <AlertTitle>Run {nextRunNumber} not started</AlertTitle>
          <AlertDescription>{start.error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="flex justify-end">
        <Dialog onOpenChange={setConfirming} open={confirming}>
          <DialogTrigger
            disabled={missingGoalMetric || state.isInvalid}
            render={<Button data-testid="review-start-run" />}
          >
            Review Start
          </DialogTrigger>
          <DialogContent className="sm:max-w-lg">
            <ExperimentRunStartConfirmation
              error={start.error}
              isStarting={start.isStarting}
              nextRunNumber={nextRunNumber}
              onBack={() => setConfirming(false)}
              onStart={() => start.start(state.draft)}
              runningRun={undefined}
              segmentIds={data.experiment.draftSegmentIds}
            />
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}

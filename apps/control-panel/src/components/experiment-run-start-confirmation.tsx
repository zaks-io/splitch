import type { PanelExperimentRun } from "@splitch/control-plane-sdk/panel-experiments";
import { Alert, AlertDescription, AlertTitle } from "@splitch/ui/components/alert";
import { Button } from "@splitch/ui/components/button";
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@splitch/ui/components/dialog";
import { Spinner } from "@splitch/ui/components/spinner";
import { startConfirmationCopy } from "#lib/experiment-run-draft-model";

/**
 * `runningRun` is the Run this Start would actually abandon, which is only ever
 * a Run that is still running. It is deliberately NOT the Run the form
 * pre-filled from: after an End, that is a Run that already stopped days ago,
 * and asking an operator to confirm abandoning it warns about a consequence
 * that has already happened. Warnings that are not true get dismissed reflexively,
 * and this is the one dialog that must not be.
 */
export function ExperimentRunStartConfirmation({
  runningRun,
  error,
  isStarting,
  nextRunNumber,
  onBack,
  onStart,
  segmentIds,
}: {
  runningRun: PanelExperimentRun | undefined;
  error: string | undefined;
  isStarting: boolean;
  nextRunNumber: number;
  onBack: () => void;
  onStart: () => void;
  segmentIds: string[];
}) {
  const { action, description, title } = startConfirmationCopy(runningRun, nextRunNumber);

  return (
    <>
      <DialogHeader>
        <DialogTitle>Start Run {nextRunNumber}?</DialogTitle>
        <DialogDescription>
          This is the Environment Policy Start gate and the final data-loss confirmation.
        </DialogDescription>
      </DialogHeader>
      <Alert variant="destructive">
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription>{description}</AlertDescription>
      </Alert>
      {segmentIds.length > 0 ? (
        <Alert data-testid="staged-segment-references">
          <AlertTitle>Segment references carry into Run {nextRunNumber}</AlertTitle>
          <AlertDescription>
            {segmentIds.join(", ")} resolve to Targeting Rules at Start. A Run freezes the resolved
            Rules, so these references are not visible on the Run afterwards.
          </AlertDescription>
        </Alert>
      ) : null}
      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Run not started</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <DialogFooter>
        <Button disabled={isStarting} onClick={onBack} variant="outline">
          Back
        </Button>
        <Button disabled={isStarting} onClick={onStart} variant="destructive">
          {isStarting ? <Spinner data-icon="inline-start" /> : null}
          {isStarting ? "Starting…" : action}
        </Button>
      </DialogFooter>
    </>
  );
}

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

export function ExperimentRunStartConfirmation({
  baseRun,
  error,
  isStarting,
  nextRunNumber,
  onBack,
  onStart,
}: {
  baseRun: PanelExperimentRun | undefined;
  error: string | undefined;
  isStarting: boolean;
  nextRunNumber: number;
  onBack: () => void;
  onStart: () => void;
}) {
  const title = baseRun
    ? `Run ${baseRun.runNumber} will be abandoned`
    : "A fresh sample will begin";
  const description = baseRun
    ? `Run ${baseRun.runNumber} stops accumulating and becomes a frozen archive. Run ${nextRunNumber} starts a fresh sample from zero. Runs are never pooled.`
    : `Run ${nextRunNumber} starts a fresh sample from zero.`;
  const action = baseRun
    ? `Abandon Run ${baseRun.runNumber} and Start Run ${nextRunNumber}`
    : `Start Run ${nextRunNumber}`;

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

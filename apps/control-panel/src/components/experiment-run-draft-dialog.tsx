import type {
  PanelExperimentDetailOutput,
  PanelExperimentRun,
} from "@splitch/control-plane-sdk/panel-experiments";
import { Button } from "@splitch/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@splitch/ui/components/dialog";
import { type FormEvent, useState } from "react";
import { useRunDraftState } from "#lib/experiment-run-draft-state";
import { useExperimentRunStart } from "#lib/use-experiment-run-start";
import { ExperimentRunDraftFields } from "./experiment-run-draft-fields";
import { ExperimentRunStartConfirmation } from "./experiment-run-start-confirmation";

export function ExperimentRunDraftDialog({
  appId,
  data,
  environmentId,
}: {
  appId: string;
  data: PanelExperimentDetailOutput;
  environmentId: string;
}) {
  // Two different questions, deliberately two different Runs: `runningRun` is
  // what a Start would abandon (nothing, if none is running), while `baseRun` is
  // only where the form pre-fills its assignment config from.
  const runningRun = data.runs.find((run) => run.status === "running");
  const baseRun = runningRun ?? data.runs[0];
  // The Control Plane assigns max(runNumber) + 1 across every Run. Deriving it
  // from `baseRun` would show a number the server will not assign whenever the
  // response is not ordered highest-first.
  const nextRunNumber = data.runs.reduce((max, run) => Math.max(max, run.runNumber), 0) + 1;
  const [open, setOpen] = useState(false);

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger render={<Button variant="outline" />}>
        Configure Run {nextRunNumber}
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <ExperimentRunDraftForm
          appId={appId}
          baseRun={baseRun}
          data={data}
          runningRun={runningRun}
          environmentId={environmentId}
          nextRunNumber={nextRunNumber}
          onStarted={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function ExperimentRunDraftForm({
  appId,
  baseRun,
  data,
  environmentId,
  nextRunNumber,
  onStarted,
  runningRun,
}: {
  appId: string;
  baseRun: PanelExperimentRun | undefined;
  data: PanelExperimentDetailOutput;
  environmentId: string;
  nextRunNumber: number;
  onStarted: () => void;
  runningRun: PanelExperimentRun | undefined;
}) {
  const state = useRunDraftState(data, baseRun);
  const [step, setStep] = useState<"configure" | "confirm">("configure");
  const start = useExperimentRunStart({
    appId,
    environmentId,
    experimentId: data.experiment.id,
    onStarted,
  });

  function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state.isInvalid) return;
    setStep("confirm");
  }

  if (step === "confirm") {
    return (
      <ExperimentRunStartConfirmation
        approvalRequest={start.approvalRequest}
        error={start.error}
        isStarting={start.isStarting}
        nextRunNumber={nextRunNumber}
        onBack={() => setStep("configure")}
        onStart={() => start.start(state.draft)}
        runningRun={runningRun}
        segmentIds={data.experiment.draftSegmentIds}
      />
    );
  }

  return (
    <form onSubmit={review}>
      <DialogHeader>
        <DialogTitle>Configure Run {nextRunNumber}</DialogTitle>
        <DialogDescription>
          Assignment config is pre-filled from {baseRun ? `Run ${baseRun.runNumber}` : "the draft"}.
          Nothing changes until Start is confirmed.
        </DialogDescription>
      </DialogHeader>
      <ExperimentRunDraftFields
        data={data}
        hasRunningRun={runningRun !== undefined}
        idPrefix="next-run"
        state={state}
      />
      <DialogFooter className="mt-4">
        <Button type="submit">Review Start</Button>
      </DialogFooter>
    </form>
  );
}

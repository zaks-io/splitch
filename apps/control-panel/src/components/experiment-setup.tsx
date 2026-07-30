import type {
  PanelExperimentDetailOutput,
  PanelExperimentRun,
} from "@splitch/control-plane-sdk/panel-experiments";
import { ExperimentAssignmentSnapshot } from "./experiment-assignment-snapshot";
import { ExperimentMeasurementForm } from "./experiment-measurement-form";
import { ExperimentMetadataForm } from "./experiment-metadata-form";
import { ExperimentRunDraftDialog } from "./experiment-run-draft-dialog";

export function ExperimentSetup({
  appId,
  data,
  environmentId,
  selectedRun,
}: {
  appId: string;
  data: PanelExperimentDetailOutput;
  environmentId: string;
  selectedRun: PanelExperimentRun | undefined;
}) {
  const liveRun = data.runs.find((run) => run.id === data.experiment.liveRunId);
  return (
    <section aria-labelledby="setup-heading" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-mono text-muted-foreground text-xs uppercase tracking-[0.16em]">
            {selectedRun ? `Run ${selectedRun.runNumber}` : "Draft"}
          </p>
          <h2 className="mt-2 font-semibold text-foreground text-xl" id="setup-heading">
            Setup
          </h2>
        </div>
        <ExperimentRunDraftDialog appId={appId} data={data} environmentId={environmentId} />
      </div>
      <ExperimentAssignmentSnapshot data={data} run={selectedRun} />
      <div className="grid items-start gap-4 xl:grid-cols-2">
        {/*
         * Both forms seed local state from props on mount only. The measurement
         * form splits Metrics against the live Run's frozen decision family, so
         * its identity is the Experiment *and* the Run: starting the next Run
         * from the dialog above invalidates the route without changing
         * `experiment.id`, and an Experiment-only key would leave the decision
         * split showing the abandoned Run's.
         */}
        <ExperimentMeasurementForm
          key={`${data.experiment.id}:${data.experiment.liveRunId ?? "no-run"}`}
          appId={appId}
          environmentId={environmentId}
          experiment={data.experiment}
          liveRun={liveRun}
          metrics={data.metrics}
        />
        <ExperimentMetadataForm
          key={data.experiment.id}
          appId={appId}
          environmentId={environmentId}
          experiment={data.experiment}
        />
      </div>
    </section>
  );
}

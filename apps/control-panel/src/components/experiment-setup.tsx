import type {
  PanelExperimentDetailOutput,
  PanelExperimentRun,
} from "@splitch/control-plane-sdk/panel-experiments";
import { Alert, AlertDescription, AlertTitle } from "@splitch/ui/components/alert";
import { useQuery } from "@tanstack/react-query";
import { renderExperimentImplementationPrompt } from "#lib/implementation-prompt";
import { environmentSettingsQuery } from "#lib/settings-query";
import { CodeAgentPrompt } from "./code-agent-prompt";
import { ExperimentAssignmentSnapshot } from "./experiment-assignment-snapshot";
import { ExperimentMeasurementForm } from "./experiment-measurement-form";
import { ExperimentMetadataForm } from "./experiment-metadata-form";
import { ExperimentRunDraftDialog } from "./experiment-run-draft-dialog";

export function ExperimentSetup({
  appId,
  data,
  environment,
  environmentId,
  selectedRun,
}: {
  appId: string;
  data: PanelExperimentDetailOutput;
  environment: string;
  environmentId: string;
  selectedRun: PanelExperimentRun | undefined;
}) {
  const liveRun = data.runs.find((run) => run.id === data.experiment.liveRunId);
  const settings = useQuery({
    ...environmentSettingsQuery({ appId, environmentId }),
    enabled: liveRun !== undefined,
  });
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
      {liveRun && settings.isPending ? (
        <p className="text-muted-foreground text-sm">Generating the code-agent prompt…</p>
      ) : null}
      {liveRun && settings.isError ? (
        <Alert variant="destructive">
          <AlertTitle>Code-agent prompt unavailable</AlertTitle>
          <AlertDescription>
            The public Client Key could not be loaded, so the Run handoff was not generated. Reload
            this page or copy the Client Key from Environment settings.
          </AlertDescription>
        </Alert>
      ) : null}
      {liveRun && settings.data ? (
        <CodeAgentPrompt
          prompt={renderExperimentImplementationPrompt({
            clientKey: settings.data.clientKey.keyMaterial,
            data,
            environment,
            run: liveRun,
          })}
          testId="experiment-code-agent-prompt"
          title={`Implement Run ${liveRun.runNumber} with your code agent`}
        />
      ) : null}
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

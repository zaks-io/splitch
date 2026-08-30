import type { PanelExperimentRun } from "@splitch/control-plane-sdk/panel-experiments";
import { useSuspenseQuery } from "@tanstack/react-query";
import { experimentResultsQuery } from "#lib/experiments/experiments-query";
import {
  ExperimentResults,
  ExperimentResultsEmpty,
  ExperimentResultsWaiting,
} from "#components/experiments/experiment-results";

/**
 * Route-facing wrapper: resolves the Run to read, then renders it.
 *
 * A Run-less Experiment renders the empty state without issuing a read, so a
 * draft never asks the Analysis Worker for statistics that cannot exist.
 * A Run with incomplete inputs renders the `no_data` waiting state from the
 * 200 envelope, never the route error page. Copy branches on runStatus so an
 * ended Run is not described as still collecting. `no_run` from the API (SPL-305)
 * is the same empty surface when a results read somehow arrives without a Run.
 */
export function ExperimentResultsPanel({
  appId,
  environmentId,
  experimentId,
  run,
}: {
  appId: string;
  environmentId: string;
  experimentId: string;
  run: PanelExperimentRun | undefined;
}) {
  if (!run) return <ExperimentResultsEmpty />;
  return (
    <ExperimentResultsForRun
      appId={appId}
      environmentId={environmentId}
      experimentId={experimentId}
      run={run}
    />
  );
}

function ExperimentResultsForRun({
  appId,
  environmentId,
  experimentId,
  run,
}: {
  appId: string;
  environmentId: string;
  experimentId: string;
  run: PanelExperimentRun;
}) {
  const { data } = useSuspenseQuery(
    experimentResultsQuery({ appId, environmentId, experimentId, runId: run.id }),
  );
  if (data.state === "no_run") {
    return <ExperimentResultsEmpty />;
  }
  if (data.state === "no_data") {
    return (
      <ExperimentResultsWaiting
        control={data.control}
        missing={data.missing}
        runNumber={data.runNumber}
        runStatus={data.runStatus}
      />
    );
  }
  return <ExperimentResults results={data} run={run} />;
}

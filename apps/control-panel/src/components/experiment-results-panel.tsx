import type { PanelExperimentRun } from "@splitch/control-plane-sdk/panel-experiments";
import { useSuspenseQuery } from "@tanstack/react-query";
import { experimentResultsQuery } from "#lib/experiments-query";
import {
  ExperimentResults,
  ExperimentResultsEmpty,
  ExperimentResultsWaiting,
} from "./experiment-results";

/**
 * Route-facing wrapper: resolves the Run to read, then renders it.
 *
 * A Run-less Experiment renders the empty state without issuing a read, so a
 * draft never asks the Analysis Worker for statistics that cannot exist.
 * A Run that is still collecting inputs renders the waiting state from the
 * 200 `no_data` discriminator — never the route error page.
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
      runId={run.id}
    />
  );
}

function ExperimentResultsForRun({
  appId,
  environmentId,
  experimentId,
  runId,
}: {
  appId: string;
  environmentId: string;
  experimentId: string;
  runId: string;
}) {
  const { data } = useSuspenseQuery(
    experimentResultsQuery({ appId, environmentId, experimentId, runId }),
  );
  if (data.state === "no_data") {
    return <ExperimentResultsWaiting missing={data.missing} runNumber={data.runNumber} />;
  }
  return <ExperimentResults results={data} />;
}

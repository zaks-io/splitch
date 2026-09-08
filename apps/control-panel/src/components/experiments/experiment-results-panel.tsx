import { Spinner } from "@splitch/ui/components/spinner";
import { lazy, Suspense, useState } from "react";

const ExperimentConclusionDialog = lazy(() =>
  import("./experiment-conclusion-dialog").then((module) => ({
    default: module.ExperimentConclusionDialog,
  })),
);

import type { Metric } from "@splitch/contracts";
import type { PanelExperimentRun } from "@splitch/control-plane-sdk/panel-experiments";
import { useSuspenseQuery } from "@tanstack/react-query";
import {
  ExperimentResults,
  ExperimentResultsEmpty,
  ExperimentResultsWaiting,
} from "#components/experiments/experiment-results";
import { experimentResultsQuery } from "#lib/experiments/experiments-query";

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
  canConclude,
  environments,
  flagId,
  environmentId,
  experimentId,
  metrics,
  run,
}: {
  appId: string;
  canConclude: boolean;
  environments: readonly { environmentId: string; env: string }[];
  flagId: string;
  environmentId: string;
  experimentId: string;
  metrics: readonly Pick<Metric, "id" | "name">[];
  run: PanelExperimentRun | undefined;
}) {
  if (!run) return <ExperimentResultsEmpty />;
  return (
    <ExperimentResultsForRun
      appId={appId}
      canConclude={canConclude}
      environments={environments}
      flagId={flagId}
      environmentId={environmentId}
      experimentId={experimentId}
      metrics={metrics}
      run={run}
    />
  );
}

function ExperimentResultsForRun({
  appId,
  canConclude,
  environments,
  flagId,
  environmentId,
  experimentId,
  metrics,
  run,
}: {
  appId: string;
  canConclude: boolean;
  environments: readonly { environmentId: string; env: string }[];
  flagId: string;
  environmentId: string;
  experimentId: string;
  metrics: readonly Pick<Metric, "id" | "name">[];
  run: PanelExperimentRun;
}) {
  const [concluding, setConcluding] = useState(false);
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
  return (
    <>
      <ExperimentResults
        canConclude={canConclude}
        onConclude={() => setConcluding(true)}
        metrics={metrics}
        results={data}
        run={run}
      />
      {concluding && data.resultToken && data.dataWatermark ? (
        <Suspense fallback={<Spinner aria-label="Loading conclusion" />}>
          <ExperimentConclusionDialog
            scope={{ appId, environmentId, experimentId, flagId, runId: run.id }}
            environments={environments}
            variants={Object.keys(run.allocation)}
            expectedResultToken={data.resultToken}
            dataWatermark={data.dataWatermark}
            onClose={() => setConcluding(false)}
          />
        </Suspense>
      ) : null}
    </>
  );
}

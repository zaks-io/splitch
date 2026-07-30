import {
  type AppOverviewResponse,
  AppOverviewResponseSchema,
  type OverviewExperiments,
  type StatsOutput,
} from "@splitch/contracts";
import { appScope, envScope, type Repository } from "@splitch/db";
import { environmentResponse } from "./app-environment-model";
import {
  type AnalysisResultsReader,
  AnalysisResultsUnavailableError,
} from "./attention-analysis-reader";
import { ExperimentIntegrityError } from "./attention-rollup-errors";
import { mapWithConcurrency } from "./bounded-map";
import { classifyOverviewExperiments, type OverviewExperimentReading } from "./overview-attention";
import { overviewFlagChanges } from "./overview-flag-changes";
import {
  FLAG_CHANGE_WINDOW_DAYS,
  OVERVIEW_ANALYSIS_READ_CONCURRENCY,
  OVERVIEW_ANALYSIS_READ_LIMIT,
} from "./overview-thresholds";
import { panelScopeAccess } from "./panel-scope-access";

interface PanelOverviewDeps {
  repo: Repository;
  analysisResults: AnalysisResultsReader;
  now?: () => Date;
}

interface PanelOverviewInput {
  actorId: string;
  appId: string;
  environmentId: string;
}

/**
 * The App Overview read for one Environment.
 *
 * A failed Analysis read degrades the Experiment section alone, to
 * `{status: "unavailable"}`, rather than refusing the whole response: the Flag
 * and Environment cards do not depend on Analysis and blanking them would hide
 * working information behind an unrelated outage. What it must never do is
 * degrade to an empty attention list, which reads as "nothing needs you"
 * (ADR-0036).
 */
export async function panelOverviewRead(
  deps: PanelOverviewDeps,
  input: PanelOverviewInput,
): Promise<Response> {
  const requestId = crypto.randomUUID();
  const access = await panelScopeAccess(deps.repo, input, requestId);
  if (!access.ok) return access.response;

  const scope = envScope(input.appId, input.environmentId);
  const [experiments, flagConfigs, flags] = await Promise.all([
    overviewExperiments(deps, input),
    deps.repo.flags.flagConfigs.findMany(scope),
    deps.repo.flags.flags.findMany(appScope(input.appId)),
  ]);

  const environment = environmentResponse(access.environment);
  const response: AppOverviewResponse = {
    appId: input.appId,
    environmentId: input.environmentId,
    experiments,
    flagConfiguration: {
      recentlyChanged: overviewFlagChanges(flagConfigs, flags, (deps.now ?? (() => new Date()))()),
      windowDays: FLAG_CHANGE_WINDOW_DAYS,
    },
    environment: {
      id: environment.id,
      key: environment.key,
      name: environment.name,
      policy: environment.policy,
    },
  };
  // We validate our own output: the SDK checks the far end of the wire, so
  // without this a Worker-side shape bug reaches the Panel as a plausible 200.
  return Response.json(AppOverviewResponseSchema.parse(response));
}

async function overviewExperiments(
  deps: PanelOverviewDeps,
  input: PanelOverviewInput,
): Promise<OverviewExperiments> {
  try {
    return await readExperimentAttention(deps, input);
  } catch (cause) {
    // Each refusal carries its own retryability, decided here where the fault is
    // known. Telling an operator to retry a corrupt row or a blown budget would
    // be a refusal that instructs an impossible fix.
    if (cause instanceof ExperimentIntegrityError) {
      return { status: "unavailable", reason: "experiment_integrity", retryable: false };
    }
    if (cause instanceof AnalysisResultsUnavailableError) {
      return { status: "unavailable", reason: "analysis_unavailable", retryable: true };
    }
    throw cause;
  }
}

async function readExperimentAttention(
  deps: PanelOverviewDeps,
  input: PanelOverviewInput,
): Promise<OverviewExperiments> {
  const scope = envScope(input.appId, input.environmentId);
  const running = await deps.repo.experiments.listRunningExperiments(scope);
  if (running.length > OVERVIEW_ANALYSIS_READ_LIMIT) {
    return { status: "unavailable", reason: "read_budget_exceeded", retryable: false };
  }

  const readings = await mapWithConcurrency(
    running,
    OVERVIEW_ANALYSIS_READ_CONCURRENCY,
    async (experiment): Promise<OverviewExperimentReading> => {
      if (!experiment.liveRunId) throw new ExperimentIntegrityError(experiment.id);
      const run = await deps.repo.experiments.getRun(scope, experiment.liveRunId);
      if (!run) throw new ExperimentIntegrityError(experiment.id);
      const stats = await deps.analysisResults.read(
        {
          appId: input.appId,
          environmentId: input.environmentId,
          experimentId: experiment.id,
          runId: experiment.liveRunId,
        },
        input.actorId,
      );
      const ref = { id: experiment.id, name: experiment.name, runId: run.id };
      // An absent Analysis result is reported, never dropped: a running Run whose
      // state nobody knows must not be subtracted from the counts the calm state
      // is computed from (ADR-0036).
      return stats === null ? { ...ref, state: "no_data" } : reading(ref, run, stats);
    },
  );

  return { status: "ok", ...classifyOverviewExperiments(readings) };
}

function reading(
  ref: { id: string; name: string; runId: string },
  run: { horizon: string; sampleSizeLocked: number | null },
  stats: StatsOutput,
): OverviewExperimentReading {
  return {
    ...ref,
    state: "read",
    horizon: run.horizon,
    sampleSizeLocked: run.sampleSizeLocked,
    stats,
  };
}

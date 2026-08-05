import { type AnalysisResultsEnvelope, AnalysisResultsEnvelopeSchema } from "@splitch/contracts";
import { envScope, type Repository } from "@splitch/db";
import { delegatedRequest } from "@splitch/worker-runtime";
import { controlPlaneRoute } from "./routes";

/** One Run's Analysis results, addressed by the Run the caller already resolved. */
export interface AnalysisResultsScope {
  appId: string;
  environmentId: string;
  experimentId: string;
  runId: string;
}

/**
 * Experiment existence and Run selection for a results read (SPL-305).
 *
 * Tinybird alone cannot tell a draft Experiment (exists, never Started) from a
 * missing or cross-tenant id — both look like empty run-input rows. The Control
 * Plane owns D1, so it separates those cases before the Analysis hop:
 * `experiment_not_found` (including out-of-scope ids — existence is not leaked),
 * `no_run` (draft: Start is the next step), `run_not_found` (pinned Run missing),
 * or a concrete `run` to forward.
 */
export type ResolvedExperimentResultsTarget =
  | { outcome: "experiment_not_found" }
  | { outcome: "no_run" }
  | { outcome: "run_not_found" }
  | { outcome: "run"; runId: string };

export async function resolveExperimentResultsTarget(
  repo: Repository,
  args: {
    appId: string;
    environmentId: string;
    experimentId: string;
    runId?: string;
  },
): Promise<ResolvedExperimentResultsTarget> {
  const scope = envScope(args.appId, args.environmentId);
  const experiment = await repo.experiments.getExperiment(scope, args.experimentId);
  // Scoped null covers both a missing id and an id that belongs to another
  // tenant. Callers must map both to EXPERIMENT_NOT_FOUND (never 403).
  if (!experiment) return { outcome: "experiment_not_found" };

  const runs = await repo.experiments.listRunsForExperiment(scope, args.experimentId);
  if (args.runId !== undefined) {
    const pinned = runs.find((candidate) => candidate.id === args.runId);
    if (!pinned) return { outcome: "run_not_found" };
    return { outcome: "run", runId: pinned.id };
  }
  if (runs.length === 0) return { outcome: "no_run" };

  const [first, ...rest] = runs;
  if (first === undefined) return { outcome: "no_run" };
  const latest = rest.reduce(
    (current, candidate) => (current.runNumber > candidate.runNumber ? current : candidate),
    first,
  );
  return { outcome: "run", runId: latest.id };
}

/**
 * Typed 200 for a draft Experiment that has never had a Run. New envelope
 * member (not a `missing` value on `no_data`): there is no `run_id` to report
 * without fabricating a placeholder.
 */
export function analysisResultsNoRunEnvelope(): AnalysisResultsEnvelope {
  return AnalysisResultsEnvelopeSchema.parse({
    state: "no_run",
    recommended_action: "START_A_RUN",
  });
}

/**
 * The Run-scoped Analysis read the Control Plane makes on its own behalf, for the
 * Panel's Experiment list and the attention rollup.
 *
 * Built through the same delegation protocol as the operator-addressed
 * `experiment_results_post` route (ADR-0046), so the Analysis Worker sees one
 * request shape rather than a second private one. `orgId` is null because this
 * route is App-scoped: its path has no `:orgId` segment for the receiving
 * cross-check to compare against.
 */
export function analysisResultsRequest(scope: AnalysisResultsScope, actorId: string): Request {
  const route = controlPlaneRoute("experiment_results_post");
  return delegatedRequest(
    route,
    {
      operation: route.id,
      actorId,
      orgId: null,
      appId: scope.appId,
      environmentId: scope.environmentId,
    },
    {
      params: {
        appId: scope.appId,
        environmentId: scope.environmentId,
        experimentId: scope.experimentId,
      },
      body: { runId: scope.runId },
    },
  );
}

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

import { type ExperimentPlanRequest, ExperimentPlanResponseSchema } from "@splitch/contracts";
import { planExperiment } from "@splitch/stats";
import { envScope } from "@splitch/db";
import { renderError, type HandlerArgs } from "@splitch/worker-runtime";
import { appNotFound } from "./app-environment-model";
import { type ExperimentDeps, environmentExists } from "./experiment-handler-shared";
import { objectBody, pathParam } from "./handler-input";

/**
 * Read-only power / MDE planner. Caller-supplied baselines only in this slice;
 * missing baselines are refused with VALIDATION_ERROR naming the fields.
 */
export async function planExperimentHandler(
  deps: ExperimentDeps,
  { input, requestId }: HandlerArgs<unknown>,
): Promise<Response> {
  const scope = envScope(pathParam(input, "appId"), pathParam(input, "environmentId"));
  if (!(await environmentExists(deps, scope))) return appNotFound(requestId);

  const body = objectBody(input) as ExperimentPlanRequest;
  const outcome = planExperiment(body);
  if (!outcome.ok) {
    return renderError(
      {
        code: "VALIDATION_ERROR",
        message: "request failed schema validation",
        details: {
          issues: outcome.issues.map((issue) => ({
            path: ["body", ...issue.path],
            message: issue.message,
          })),
        },
      },
      { requestId },
    );
  }

  return Response.json(ExperimentPlanResponseSchema.parse(outcome.plan));
}

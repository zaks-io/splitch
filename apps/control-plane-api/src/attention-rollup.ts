import {
  type EnvironmentAttentionRollup,
  type ErrorResponse,
  ErrorResponseSchema,
  StatsOutputSchema,
  type StatsOutput,
} from "@splitch/contracts";
import { scopedAnalysisResultsRequest } from "@splitch/control-plane-sdk/panel-experiments";
import { appScope, envScope, type Repository } from "@splitch/db";
import { renderError, type HandlerArgs } from "@splitch/worker-runtime";
import { appNotFound } from "./app-environment-model";
import { pathParam } from "./handler-input";

interface AnalysisResultsScope {
  appId: string;
  environmentId: string;
  experimentId: string;
  runId: string;
}

export interface AnalysisResultsReader {
  read(scope: AnalysisResultsScope, actorId: string): Promise<StatsOutput | null>;
}

export const unavailableAnalysisResults: AnalysisResultsReader = {
  async read() {
    throw new AnalysisResultsUnavailableError("analysis results binding is unavailable");
  },
};

interface FetcherLike {
  fetch(request: Request): Promise<Response>;
}

interface AttentionRollupDeps {
  repo: Repository;
  analysisResults: AnalysisResultsReader;
}

export function makeAttentionRollupHandler(deps: AttentionRollupDeps) {
  return async ({ input, principal, requestId }: HandlerArgs<unknown>): Promise<Response> => {
    const appId = pathParam(input, "appId");
    const app = await deps.repo.identity.getApp(appId);
    if (!app) return appNotFound(requestId);

    const [orgMembership, appMembership] = await Promise.all([
      deps.repo.identity.getOrgMembership(app.organizationId, principal.id),
      deps.repo.identity.getAppMembership(appScope(appId), principal.id),
    ]);
    if (!orgMembership || !appMembership) return forbidden(requestId);

    try {
      const environments = await deps.repo.identity.listEnvironments(appScope(appId));
      const items = await Promise.all(
        environments.map((environment) =>
          rollupEnvironment(deps, appId, environment.id, principal.id),
        ),
      );
      return Response.json({ appId, items });
    } catch (cause) {
      if (cause instanceof AnalysisResultsUnavailableError) {
        return renderError(
          {
            code: "SERVICE_UNAVAILABLE",
            message: "analysis attention data is unavailable",
            details: { retryAfterMs: 30_000 },
          },
          { requestId },
        );
      }
      throw cause;
    }
  };
}

async function rollupEnvironment(
  deps: AttentionRollupDeps,
  appId: string,
  environmentId: string,
  actorId: string,
): Promise<EnvironmentAttentionRollup> {
  const experiments = await deps.repo.experiments.listRunningExperiments(
    envScope(appId, environmentId),
  );
  const results = await Promise.all(
    experiments.map((experiment) => {
      if (!experiment.liveRunId) {
        throw new AnalysisResultsUnavailableError(
          `running Experiment ${experiment.id} has no live Run`,
        );
      }
      return deps.analysisResults.read(
        { appId, environmentId, experimentId: experiment.id, runId: experiment.liveRunId },
        actorId,
      );
    }),
  );
  const available = results.filter((result): result is StatsOutput => result !== null);
  if (available.length === 0) {
    return { environmentId, state: "no_data", srm: false, guardrail: false };
  }

  const srm = available.some(
    (result) => result.srm.srm_is_mismatch || result.srm.activated_srm_mismatch === true,
  );
  const guardrail = available.some((result) =>
    result.guardrail_results.some((item) => item.is_breached === true),
  );
  return {
    environmentId,
    state: srm || guardrail ? "attention" : "clear",
    srm,
    guardrail,
  };
}

export function createAnalysisResultsReader(fetcher: FetcherLike): AnalysisResultsReader {
  return {
    async read(scope, actorId) {
      let response: Response;
      try {
        response = await fetcher.fetch(
          scopedAnalysisResultsRequest({
            operation: "experiment_results_post",
            actorId,
            ...scope,
          }),
        );
      } catch (cause) {
        throw new AnalysisResultsUnavailableError(cause);
      }
      return parseAnalysisResponse(response);
    },
  };
}

async function parseAnalysisResponse(response: Response): Promise<StatsOutput | null> {
  if (!response.ok) {
    const error = await safeError(response);
    if (response.status === 404 && isMissingAnalysisResult(error)) return null;
    throw new AnalysisResultsUnavailableError(error);
  }
  try {
    return StatsOutputSchema.parse(await response.json());
  } catch (cause) {
    throw new AnalysisResultsUnavailableError(cause);
  }
}

async function safeError(response: Response): Promise<ErrorResponse | { status: number }> {
  try {
    const parsed = ErrorResponseSchema.safeParse(await response.json());
    if (parsed.success) return parsed.data;
  } catch {
    // The error is deliberately collapsed at this internal boundary.
  }
  return { status: response.status };
}

function isMissingAnalysisResult(
  error: ErrorResponse | { status: number },
): error is Extract<ErrorResponse, { code: "EXPERIMENT_NOT_FOUND" | "RUN_NOT_FOUND" }> {
  return (
    "code" in error && (error.code === "EXPERIMENT_NOT_FOUND" || error.code === "RUN_NOT_FOUND")
  );
}

class AnalysisResultsUnavailableError extends Error {
  constructor(readonly detail: unknown) {
    super("analysis results unavailable");
    this.name = "AnalysisResultsUnavailableError";
  }
}

function forbidden(requestId: string): Response {
  return renderError(
    { code: "FORBIDDEN", message: "credential is not allowed for this App", details: {} },
    { requestId },
  );
}

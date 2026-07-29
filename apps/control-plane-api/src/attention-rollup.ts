import {
  type EnvironmentAttentionRollup,
  type ErrorResponse,
  ErrorResponseSchema,
  StatsOutputSchema,
  type StatsOutput,
} from "@splitch/contracts";
import {
  guardrailBreached,
  scopedAnalysisResultsRequest,
  srmFiring,
} from "@splitch/control-plane-sdk/panel-experiments";
import { appScope, envScope, type Repository } from "@splitch/db";
import { renderError, type HandlerArgs } from "@splitch/worker-runtime";
import { appNotFound } from "./app-environment-model";
import { pathParam } from "./handler-input";

/** Concurrent Analysis reads per rollup request, across all Environments. */
export const ANALYSIS_READ_CONCURRENCY = 8;

/**
 * Hard ceiling on Analysis reads for one rollup. This read is polled by agents and
 * by the Panel, and each read is a subrequest; past this many the request is refused
 * whole rather than truncated, because a truncated rollup reads as "clear".
 */
export const ANALYSIS_READ_LIMIT = 200;

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
    const denial = await denyUnlessAppMember(deps, appId, principal.id, requestId);
    if (denial) return denial;

    try {
      const plans = await planRollup(deps, appId);
      const runningExperiments = plans.reduce((total, plan) => total + plan.reads.length, 0);
      if (runningExperiments > ANALYSIS_READ_LIMIT) {
        return fanoutLimitExceeded(appId, runningExperiments, plans.length, requestId);
      }

      const items = await rollupPlans(deps, plans, principal.id);
      return Response.json({ appId, items });
    } catch (cause) {
      if (cause instanceof AnalysisResultsUnavailableError) return analysisUnavailable(requestId);
      throw cause;
    }
  };
}

interface EnvironmentPlan {
  environmentId: string;
  reads: AnalysisResultsScope[];
}

/**
 * Rechecks live Organization AND App membership for this exact call, before any
 * Analysis read. Returns the refusal to send, or undefined when the caller is in
 * scope. Membership is never cached across calls.
 */
async function denyUnlessAppMember(
  deps: AttentionRollupDeps,
  appId: string,
  actorId: string,
  requestId: string,
): Promise<Response | undefined> {
  const app = await deps.repo.identity.getApp(appId);
  if (!app) return appNotFound(requestId);

  const [orgMembership, appMembership] = await Promise.all([
    deps.repo.identity.getOrgMembership(app.organizationId, actorId),
    deps.repo.identity.getAppMembership(appScope(appId), actorId),
  ]);
  if (!orgMembership || !appMembership) return forbidden(requestId);
  return undefined;
}

/** Resolves the whole App's Analysis read plan without issuing any of the reads. */
async function planRollup(deps: AttentionRollupDeps, appId: string): Promise<EnvironmentPlan[]> {
  const environments = await deps.repo.identity.listEnvironments(appScope(appId));
  return mapWithConcurrency(environments, ANALYSIS_READ_CONCURRENCY, (environment) =>
    planEnvironment(deps, appId, environment.id),
  );
}

/** Resolves which Analysis reads an Environment needs, without issuing any of them. */
async function planEnvironment(
  deps: AttentionRollupDeps,
  appId: string,
  environmentId: string,
): Promise<EnvironmentPlan> {
  const experiments = await deps.repo.experiments.listRunningExperiments(
    envScope(appId, environmentId),
  );
  return {
    environmentId,
    reads: experiments.map((experiment) => {
      if (!experiment.liveRunId) {
        throw new AnalysisResultsUnavailableError(
          `running Experiment ${experiment.id} has no live Run`,
        );
      }
      return { appId, environmentId, experimentId: experiment.id, runId: experiment.liveRunId };
    }),
  };
}

async function rollupPlans(
  deps: AttentionRollupDeps,
  plans: EnvironmentPlan[],
  actorId: string,
): Promise<EnvironmentAttentionRollup[]> {
  // One pool across every Environment, so concurrency is a property of the request
  // rather than of how many Environments the App happens to have.
  const results = await mapWithConcurrency(
    plans.flatMap((plan) => plan.reads),
    ANALYSIS_READ_CONCURRENCY,
    (scope) => deps.analysisResults.read(scope, actorId),
  );

  const items: EnvironmentAttentionRollup[] = [];
  let offset = 0;
  for (const plan of plans) {
    const available = results
      .slice(offset, offset + plan.reads.length)
      .filter((result): result is StatsOutput => result !== null);
    offset += plan.reads.length;
    items.push(attentionFor(plan.environmentId, available));
  }
  return items;
}

function attentionFor(environmentId: string, available: StatsOutput[]): EnvironmentAttentionRollup {
  if (available.length === 0) {
    return { environmentId, state: "no_data", srm: false, guardrail: false };
  }
  const srm = available.some(srmFiring);
  const guardrail = available.some(guardrailBreached);
  return {
    environmentId,
    state: srm || guardrail ? "attention" : "clear",
    srm,
    guardrail,
  };
}

/**
 * Order-preserving bounded map. Stops pulling work after the first failure and
 * rethrows it, so a dead Analysis boundary costs one pool's worth of reads
 * instead of one read per running Experiment.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  const queue = [...items.entries()];
  let cursor = 0;
  let failure: { cause: unknown } | undefined;

  const worker = async (): Promise<void> => {
    for (
      let entry = queue[cursor++];
      entry !== undefined && failure === undefined;
      entry = queue[cursor++]
    ) {
      const [index, item] = entry;
      try {
        out[index] = await run(item);
      } catch (cause) {
        failure ??= { cause };
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, () => worker()));
  if (failure) throw failure.cause;
  return out;
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

function fanoutLimitExceeded(
  appId: string,
  runningExperiments: number,
  environments: number,
  requestId: string,
): Response {
  return renderError(
    {
      code: "ATTENTION_FANOUT_LIMIT_EXCEEDED",
      message: `attention rollup spans ${runningExperiments} running Experiments, above the ${ANALYSIS_READ_LIMIT} read limit`,
      details: { appId, limit: ANALYSIS_READ_LIMIT, runningExperiments, environments },
    },
    { requestId },
  );
}

function analysisUnavailable(requestId: string): Response {
  return renderError(
    {
      code: "SERVICE_UNAVAILABLE",
      message: "analysis attention data is unavailable",
      details: { retryAfterMs: 30_000 },
    },
    { requestId },
  );
}

function forbidden(requestId: string): Response {
  return renderError(
    { code: "FORBIDDEN", message: "credential is not allowed for this App", details: {} },
    { requestId },
  );
}

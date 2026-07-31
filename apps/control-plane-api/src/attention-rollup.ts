import {
  AppAttentionRollupResponseSchema,
  type EnvironmentAttentionRollup,
  type StatsOutput,
} from "@splitch/contracts";
import { guardrailBreached, srmFiring } from "@splitch/control-plane-sdk/panel-experiments";
import { appScope, envScope, type Repository } from "@splitch/db";
import type { HandlerArgs } from "@splitch/worker-runtime";
import { appNotFound } from "./app-environment-model";
import {
  type AnalysisResultsReader,
  type AnalysisResultsScope,
  AnalysisResultsUnavailableError,
} from "./attention-analysis-reader";
import {
  analysisUnavailable,
  ExperimentIntegrityError,
  experimentIntegrityFault,
  fanoutLimitExceeded,
  forbidden,
  missingLiveRun,
  truncatedRunningExperimentRead,
} from "./attention-rollup-errors";
import { mapWithConcurrency } from "./bounded-map";
import { pathParam } from "./handler-input";

/** Concurrent Analysis reads per rollup request, across all Environments. */
export const ANALYSIS_READ_CONCURRENCY = 8;

/**
 * Hard ceiling on Analysis reads for one rollup. This read is polled by agents and
 * by the Panel, and each read is a subrequest; past this many the request is refused
 * whole rather than truncated, because a truncated rollup reads as "clear".
 */
export const ANALYSIS_READ_LIMIT = 200;

/**
 * Hard ceiling on Environments planned for one rollup. Planning costs one D1 read
 * per Environment on the common path, plus a second COUNT only when that read
 * comes back exactly at its own bound (see `planEnvironment`), so this has to be
 * checked before planning starts: an App with thousands of Environments would
 * otherwise exhaust the subrequest budget mid-plan and surface as an untyped 500
 * instead of this refusal.
 */
export const ENVIRONMENT_FANOUT_LIMIT = 200;

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
      return await rollupResponse(deps, appId, principal.id, requestId);
    } catch (cause) {
      if (cause instanceof ExperimentIntegrityError)
        return experimentIntegrityFault(cause, requestId);
      if (cause instanceof AnalysisResultsUnavailableError) return analysisUnavailable(requestId);
      throw cause;
    }
  };
}

/**
 * Both fan-out budgets are checked before the work they bound: the Environment
 * count before the per-Environment planning reads, and the planned Analysis reads
 * before any of them are issued. Neither is truncated, because a partial rollup
 * renders as "clear" for the Environments it dropped.
 */
async function rollupResponse(
  deps: AttentionRollupDeps,
  appId: string,
  actorId: string,
  requestId: string,
): Promise<Response> {
  // One row past the budget is all it takes to decide, so the read that enforces
  // the bound is itself bounded: materializing every row first would be the same
  // unbounded work the budget exists to refuse.
  const environments = await deps.repo.identity.listEnvironments(appScope(appId), {
    limit: ENVIRONMENT_FANOUT_LIMIT + 1,
  });
  if (environments.length > ENVIRONMENT_FANOUT_LIMIT) {
    // The bounded read proves the budget is blown but cannot say by how much, and
    // an error that explains a refusal must not report a count it made up. One
    // COUNT, only on the path that is already failing, buys the honest number.
    return fanoutLimitExceeded(
      {
        appId,
        limit: ENVIRONMENT_FANOUT_LIMIT,
        environments: await deps.repo.identity.countEnvironments(appScope(appId)),
      },
      requestId,
    );
  }

  const plans = await planRollup(deps, appId, environments);
  // The true total, from a COUNT per Environment, not `plan.reads.length`. The
  // materializing read below is itself bounded (to avoid unbounded row
  // materialization in one Environment), so its length is a floor once an
  // Environment holds more running Experiments than that bound; reporting that
  // floor as the total would be exactly the disguised-default ADR-0036 forbids.
  const runningExperiments = plans.reduce((total, plan) => total + plan.runningTotal, 0);
  if (runningExperiments > ANALYSIS_READ_LIMIT) {
    return fanoutLimitExceeded(
      {
        appId,
        limit: ANALYSIS_READ_LIMIT,
        environments: plans.length,
        runningExperiments,
      },
      requestId,
    );
  }

  const items = await rollupPlans(deps, plans, actorId);
  // We validate our own output: the SDK checks the far end of the wire, so without
  // this a Worker-side shape bug reaches the Panel and every agent as a plausible
  // 200. Parsing here makes our own fabrication fail loud instead (ADR-0036).
  return Response.json(AppAttentionRollupResponseSchema.parse({ appId, items }));
}

/** Exported for `attention-rollup-plan-guard.test.ts`, which unit tests `assertPlansComplete` directly. */
export interface EnvironmentPlan {
  environmentId: string;
  /** The true running-Experiment count for this Environment, from `COUNT`. */
  runningTotal: number;
  reads: AnalysisResultsScope[];
}

/**
 * The invariant this whole module exists to hold, checked at the point the
 * reads are actually consumed rather than trusted from the callers that build
 * them. Everything upstream (the whole-rollup budget check, the per-Environment
 * read bound) is what SHOULD make every plan complete; this is what makes it
 * ALWAYS true regardless of how those change. Exported so this can be proven
 * directly, independent of whether today's callers can produce a mismatch.
 */
export function assertPlansComplete(plans: readonly EnvironmentPlan[]): void {
  for (const plan of plans) {
    if (plan.reads.length !== plan.runningTotal) {
      throw truncatedRunningExperimentRead(
        plan.environmentId,
        plan.runningTotal,
        plan.reads.length,
      );
    }
  }
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
async function planRollup(
  deps: AttentionRollupDeps,
  appId: string,
  environments: readonly { id: string }[],
): Promise<EnvironmentPlan[]> {
  return mapWithConcurrency(environments, ANALYSIS_READ_CONCURRENCY, (environment) =>
    planEnvironment(deps, appId, environment.id),
  );
}

/**
 * Resolves which Analysis reads an Environment needs, without issuing any of
 * them, plus the Environment's true running-Experiment count.
 *
 * The materializing read is bounded to `ANALYSIS_READ_LIMIT + 1` (one row past
 * the whole-rollup budget is enough to build every read this Environment could
 * still contribute once the budget check below passes; more than that would be
 * discarded work). Its own length is already the true total UNLESS it comes
 * back at exactly that bound: only then might more rows exist that it did not
 * see, so only then is a second COUNT subrequest worth issuing. This keeps the
 * common case at one D1 read per Environment while still never reporting a
 * bounded page size as if it were a total (ADR-0036).
 */
async function planEnvironment(
  deps: AttentionRollupDeps,
  appId: string,
  environmentId: string,
): Promise<EnvironmentPlan> {
  const scope = envScope(appId, environmentId);
  const experiments = await deps.repo.experiments.listRunningExperiments(scope, {
    limit: ANALYSIS_READ_LIMIT + 1,
  });
  const runningTotal =
    experiments.length === ANALYSIS_READ_LIMIT + 1
      ? await deps.repo.experiments.countRunningExperiments(scope)
      : experiments.length;
  return {
    environmentId,
    runningTotal,
    // Only checks the rows this Environment's bounded read actually saw: a
    // corrupt Experiment past the bound would not be caught here during
    // planning, but any request that reaches that many running Experiments in
    // one Environment already 409s on the budget above before this result is
    // used, so the corrupt row is never silently skipped, only reported later.
    reads: experiments.map((experiment) => {
      if (!experiment.liveRunId) throw missingLiveRun(experiment.id);
      return { appId, environmentId, experimentId: experiment.id, runId: experiment.liveRunId };
    }),
  };
}

async function rollupPlans(
  deps: AttentionRollupDeps,
  plans: EnvironmentPlan[],
  actorId: string,
): Promise<EnvironmentAttentionRollup[]> {
  assertPlansComplete(plans);

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

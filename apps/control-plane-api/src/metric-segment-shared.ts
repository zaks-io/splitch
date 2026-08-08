import type { Condition, Metric, MetricKind, Segment } from "@splitch/contracts";
import { appScope, envScope, type Repository } from "@splitch/db";
import { renderError } from "@splitch/worker-runtime";
import { requireAppWrite as requireAppWriteAuthz } from "./app-authz";
import { appNotFound } from "./app-environment-model";
import type { ConfigStoreAccess } from "./config-store-do";
import type { RunningBlocker } from "./flag-definition-guards";
import { pathParam } from "./handler-input";

export interface MetricSegmentDeps {
  repo: Repository;
  configStore?: ConfigStoreAccess;
  nowIso?: () => string;
}

export type MetricRow = NonNullable<Awaited<ReturnType<Repository["experiments"]["getMetric"]>>>;
export type SegmentRow = NonNullable<Awaited<ReturnType<Repository["flags"]["getSegment"]>>>;
type ExperimentRow = Awaited<
  ReturnType<Repository["experiments"]["listRunningExperiments"]>
>[number];
export type Result<T> = { ok: true; value: T } | { ok: false; response: Response };

export async function requireWritableApp(
  deps: MetricSegmentDeps,
  appId: string,
  actor: { id: string; scopes: readonly string[] },
  requestId: string,
): Promise<Response | null> {
  if (!(await deps.repo.identity.getApp(appId))) return appNotFound(requestId);
  return requireAppWriteAuthz(deps, appId, actor, requestId);
}

export function metricResponse(row: MetricRow): Metric {
  return {
    id: row.id,
    appId: row.appId,
    key: row.key,
    name: row.name,
    ...(row.description ? { description: row.description } : {}),
    kind: row.kind as MetricKind,
    eventName: row.eventName,
    ...(row.eventValueField ? { eventValueField: row.eventValueField } : {}),
    ...(row.denominatorMetricId ? { denominator: { metricId: row.denominatorMetricId } } : {}),
    // Analysis config is reported as an explicit null when unset, not omitted:
    // "no preference, engine default applies" is an answer a caller acts on, and
    // an absent key reads as "this build does not have the field".
    downsideThresholdPct: row.downsideThresholdPct,
    winsorize: row.winsorize,
    winsorizePct: row.winsorizePct,
    cuped: row.cuped,
    cupedCoverageThresholdPct: row.cupedCoverageThresholdPct,
    createdAt: row.createdAt,
  };
}

export function segmentResponse(row: SegmentRow): Segment {
  return {
    id: row.id,
    appId: row.appId,
    name: row.name,
    ...(row.description ? { description: row.description } : {}),
    conditions: JSON.parse(row.conditions) as Condition[],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function metricFromPath(deps: MetricSegmentDeps, input: unknown): Promise<MetricRow | null> {
  return deps.repo.experiments.getMetric(
    appScope(pathParam(input, "appId")),
    pathParam(input, "metricId"),
  );
}

export function segmentFromPath(
  deps: MetricSegmentDeps,
  input: unknown,
): Promise<SegmentRow | null> {
  return deps.repo.flags.getSegment(
    appScope(pathParam(input, "appId")),
    pathParam(input, "segmentId"),
  );
}

export async function runningMetricReference(
  deps: MetricSegmentDeps,
  appId: string,
  metricId: string,
): Promise<RunningBlocker | null> {
  // Metric delete/patch only blocks on a *running* Run (route contract + SPL-289).
  // Draft or ended Experiments may still name the Metric; that is not
  // EXPERIMENT_RUNNING. Start re-checks Metric refs via validateMetricRefs so a
  // dangling draft reference fails loud with VALIDATION_ERROR rather than
  // freezing a nonexistent Metric into the Run's decision family.
  return anyRunningReference(deps, appId, (experiment) =>
    experimentReferencesMetric(experiment, metricId),
  );
}

async function anyRunningReference(
  deps: MetricSegmentDeps,
  appId: string,
  references: (experiment: ExperimentRow) => boolean,
): Promise<RunningBlocker | null> {
  const envs = await deps.repo.identity.listEnvironments(appScope(appId));
  for (const env of envs) {
    const scope = envScope(appId, env.id);
    for (const experiment of await deps.repo.experiments.listExperiments(scope)) {
      if (!references(experiment)) continue;
      const run = await resolveRunningRun(deps, scope, experiment);
      if (!run) continue;
      return { experimentId: experiment.id, runId: run.id };
    }
  }
  return null;
}

async function resolveRunningRun(
  deps: MetricSegmentDeps,
  scope: ReturnType<typeof envScope>,
  experiment: ExperimentRow,
): Promise<{ id: string } | null> {
  const live = experiment.liveRunId
    ? await deps.repo.experiments.getRun(scope, experiment.liveRunId)
    : null;
  if (live?.status === "running") return live;
  return deps.repo.experiments.findRunningRunForExperiment(scope, experiment.id);
}

function experimentReferencesMetric(experiment: ExperimentRow, metricId: string): boolean {
  return (
    experiment.activationMetricId === metricId ||
    metricRefs(experiment.metrics).includes(metricId) ||
    metricRefs(experiment.guardrailMetrics).includes(metricId)
  );
}

function metricRefs(raw: string): string[] {
  return jsonArray(raw)
    .map((item) => {
      if (typeof item !== "object" || item === null) return null;
      const ref = item as { metricId?: string; metric_id?: string };
      return ref.metricId ?? ref.metric_id ?? null;
    })
    .filter((value): value is string => typeof value === "string");
}

function jsonArray(raw: string | null): unknown[] {
  if (!raw) return [];
  const parsed = JSON.parse(raw) as unknown;
  return Array.isArray(parsed) ? parsed : [];
}

export function decisionLockedError(
  blocker: RunningBlocker,
  fields: string[],
  requestId: string,
): Response {
  return renderError(
    {
      code: "DECISION_LOCKED",
      message: "running Run locks this Metric for decision-valid results",
      details: {
        lockedFields: fields.map((field) => `metric.${field}`),
        currentRunId: blocker.runId,
        attemptedChange: "PATCH_METRIC",
        recommendedAction: "CREATE_NEW_RUN",
      },
    },
    { requestId },
  );
}

export function metricNotFound(requestId: string): Response {
  return renderError(
    { code: "METRIC_NOT_FOUND", message: "metric not found", details: {} },
    { requestId },
  );
}

export function segmentNotFound(requestId: string): Response {
  return renderError(
    { code: "SEGMENT_NOT_FOUND", message: "segment not found", details: {} },
    { requestId },
  );
}

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function fail(response: Response): Result<never> {
  return { ok: false, response };
}

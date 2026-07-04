import type { Condition, Metric, MetricKind, Segment } from "@splitch/contracts";
import { appScope, envScope, type Repository } from "@splitch/db";
import { renderError } from "@splitch/worker-runtime";
import { requireAppWrite as requireAppWriteAuthz } from "./app-authz";
import { appNotFound } from "./app-environment-model";
import type { RunningBlocker } from "./flag-definition-guards";
import { pathParam } from "./handler-input";

export interface MetricSegmentDeps {
  repo: Repository;
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
  userId: string,
  requestId: string,
): Promise<Response | null> {
  if (!(await deps.repo.identity.getApp(appId))) return appNotFound(requestId);
  return requireAppWriteAuthz(deps, appId, userId, requestId);
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
  return runningReference(deps, appId, (experiment) =>
    experimentReferencesMetric(experiment, metricId),
  );
}

export async function runningSegmentReference(
  deps: MetricSegmentDeps,
  appId: string,
  segmentId: string,
): Promise<RunningBlocker | null> {
  return runningReference(deps, appId, (experiment) =>
    jsonArray(experiment.draftSegmentIds).includes(segmentId),
  );
}

async function runningReference(
  deps: MetricSegmentDeps,
  appId: string,
  references: (experiment: ExperimentRow) => boolean,
): Promise<RunningBlocker | null> {
  const envs = await deps.repo.identity.listEnvironments(appScope(appId));
  for (const env of envs) {
    const scope = envScope(appId, env.id);
    for (const experiment of await deps.repo.experiments.listRunningExperiments(scope)) {
      if (!references(experiment)) continue;
      const run = experiment.liveRunId
        ? await deps.repo.experiments.getRun(scope, experiment.liveRunId)
        : await deps.repo.experiments.findRunningRunForExperiment(scope, experiment.id);
      return { experimentId: experiment.id, runId: run?.id ?? experiment.liveRunId ?? "unknown" };
    }
  }
  return null;
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

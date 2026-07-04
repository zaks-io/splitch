import type { MetricKind, MetricRef } from "@splitch/contracts";
import { appScope, type Repository, type TenantScope } from "@splitch/db";
import type { HandlerArgs } from "@splitch/worker-runtime";
import { appNotFound, nowIso } from "./app-environment-model";
import { randomHex } from "./credential-cache";
import { runningExperimentError, validationError } from "./flag-definition-errors";
import { objectBody, pathParam } from "./handler-input";
import {
  decisionLockedError,
  fail,
  metricFromPath,
  metricNotFound,
  metricResponse,
  ok,
  requireWritableApp,
  runningMetricReference,
  type MetricRow,
  type MetricSegmentDeps,
  type Result,
} from "./metric-segment-shared";

export function makeMetricHandlers(deps: MetricSegmentDeps) {
  return {
    listMetrics: (args: HandlerArgs<unknown>) => listMetrics(deps, args),
    createMetric: (args: HandlerArgs<unknown>) => createMetric(deps, args),
    getMetric: (args: HandlerArgs<unknown>) => getMetric(deps, args),
    updateMetric: (args: HandlerArgs<unknown>) => updateMetric(deps, args),
    deleteMetric: (args: HandlerArgs<unknown>) => deleteMetric(deps, args),
  };
}

async function listMetrics(
  deps: MetricSegmentDeps,
  { input, requestId }: HandlerArgs<unknown>,
): Promise<Response> {
  const appId = pathParam(input, "appId");
  if (!(await deps.repo.identity.getApp(appId))) return appNotFound(requestId);
  const rows = await deps.repo.experiments.metrics.findMany(appScope(appId));
  return Response.json({ items: rows.map(metricResponse) });
}

async function createMetric(
  deps: MetricSegmentDeps,
  { input, principal, requestId }: HandlerArgs<unknown>,
): Promise<Response> {
  const appId = pathParam(input, "appId");
  const body = objectBody(input);
  const writeError = await requireWritableApp(deps, appId, principal.id, requestId);
  if (writeError) return writeError;
  if (body.appId !== appId) {
    return validationError(requestId, [["body", "appId"], "appId must match path appId"]);
  }

  const scope = appScope(appId);
  const prepared = await prepareMetricWrite(deps, scope, null, body, requestId);
  if (!prepared.ok) return prepared.response;

  const row = await deps.repo.experiments.metrics.insert(scope, {
    id: `metric_${randomHex(12)}`,
    appId,
    key: body.key as string,
    name: body.name as string,
    ...(body.description ? { description: body.description as string } : {}),
    kind: prepared.value.kind,
    eventName: prepared.value.eventName,
    eventValueField: prepared.value.eventValueField,
    denominatorMetricId: prepared.value.denominatorMetricId,
    createdAt: nowIso(deps),
    createdBy: principal.id,
  });
  return Response.json(metricResponse(row));
}

async function getMetric(
  deps: MetricSegmentDeps,
  { input, requestId }: HandlerArgs<unknown>,
): Promise<Response> {
  const metric = await metricFromPath(deps, input);
  if (!metric) return metricNotFound(requestId);
  return Response.json(metricResponse(metric));
}

async function updateMetric(
  deps: MetricSegmentDeps,
  args: HandlerArgs<unknown>,
): Promise<Response> {
  const appId = pathParam(args.input, "appId");
  const metric = await metricFromPath(deps, args.input);
  if (!metric) return metricNotFound(args.requestId);

  const writeError = await requireWritableApp(deps, appId, args.principal.id, args.requestId);
  if (writeError) return writeError;

  const body = objectBody(args.input);
  const blocker = await runningMetricReference(deps, appId, metric.id);
  if (blocker) return decisionLockedError(blocker, Object.keys(body), args.requestId);

  const prepared = await prepareMetricWrite(deps, appScope(appId), metric, body, args.requestId);
  if (!prepared.ok) return prepared.response;

  const patch = metricPatch(body, prepared.value);
  const updated =
    Object.keys(patch).length === 0
      ? metric
      : await deps.repo.experiments.updateMetric(appScope(appId), metric.id, patch);
  if (!updated) return metricNotFound(args.requestId);
  return Response.json(metricResponse(updated));
}

async function deleteMetric(
  deps: MetricSegmentDeps,
  args: HandlerArgs<unknown>,
): Promise<Response> {
  const appId = pathParam(args.input, "appId");
  const metric = await metricFromPath(deps, args.input);
  if (!metric) return metricNotFound(args.requestId);

  const writeError = await requireWritableApp(deps, appId, args.principal.id, args.requestId);
  if (writeError) return writeError;

  const blocker = await runningMetricReference(deps, appId, metric.id);
  if (blocker) return runningExperimentError(blocker, "DELETE_METRIC", args.requestId);

  await deps.repo.experiments.removeMetric(appScope(appId), metric.id);
  return Response.json({ deleted: true });
}

interface PreparedMetricWrite {
  kind: MetricKind;
  eventName: string;
  eventValueField: string | null;
  denominatorMetricId: string | null;
}

async function prepareMetricWrite(
  deps: MetricSegmentDeps,
  scope: TenantScope,
  current: MetricRow | null,
  body: Record<string, unknown>,
  requestId: string,
): Promise<Result<PreparedMetricWrite>> {
  if (current && body.kind !== undefined && body.kind !== current.kind) {
    return fail(validationError(requestId, [["body", "kind"], "Metric kind is immutable"]));
  }

  const key = (body.key ?? current?.key) as string;
  if (await metricKeyExists(deps, scope, key, current?.id)) {
    return fail(validationError(requestId, [["body", "key"], "Metric key already exists"]));
  }

  const prepared = {
    kind: (current?.kind ?? body.kind) as MetricKind,
    eventName: (body.eventName ?? current?.eventName) as string,
    eventValueField: metricField(body, current),
    denominatorMetricId: metricDenominator(body, current),
  };
  return (await validateMetricShape(deps, scope, current?.id, prepared, requestId)) ?? ok(prepared);
}

function metricField(body: Record<string, unknown>, current: MetricRow | null): string | null {
  return body.eventValueField !== undefined
    ? (body.eventValueField as string)
    : (current?.eventValueField ?? null);
}

function metricDenominator(
  body: Record<string, unknown>,
  current: MetricRow | null,
): string | null {
  if (body.denominator !== undefined) {
    return ((body.denominator as MetricRef | null)?.metricId ?? null) as string | null;
  }
  return current?.denominatorMetricId ?? null;
}

async function validateMetricShape(
  deps: MetricSegmentDeps,
  scope: TenantScope,
  metricId: string | undefined,
  prepared: PreparedMetricWrite,
  requestId: string,
): Promise<Result<never> | null> {
  const shapeIssue = metricShapeIssue(prepared, metricId, requestId);
  if (shapeIssue) return fail(shapeIssue);
  if (!prepared.denominatorMetricId) return null;
  if (!(await deps.repo.experiments.getMetric(scope, prepared.denominatorMetricId))) {
    return fail(
      metricIssue(requestId, "denominator", "denominator Metric must belong to this App"),
    );
  }
  return null;
}

function metricShapeIssue(
  prepared: PreparedMetricWrite,
  metricId: string | undefined,
  requestId: string,
): Response | null {
  if ((prepared.kind === "count" || prepared.kind === "revenue") && !prepared.eventValueField) {
    return metricIssue(
      requestId,
      "eventValueField",
      `${prepared.kind} Metric requires eventValueField`,
    );
  }
  if (prepared.kind === "ratio" && !prepared.denominatorMetricId) {
    return metricIssue(requestId, "denominator", "ratio Metric requires denominator");
  }
  if (prepared.kind !== "ratio" && prepared.denominatorMetricId) {
    return metricIssue(requestId, "denominator", "only ratio Metrics may set denominator");
  }
  if (prepared.kind === "binomial" && prepared.eventValueField) {
    return metricIssue(requestId, "eventValueField", "binomial Metric cannot set eventValueField");
  }
  if (prepared.denominatorMetricId === metricId) {
    return metricIssue(requestId, "denominator", "Metric cannot use itself as denominator");
  }
  return null;
}

function metricIssue(requestId: string, field: string, message: string): Response {
  return validationError(requestId, [["body", field], message]);
}

async function metricKeyExists(
  deps: MetricSegmentDeps,
  scope: TenantScope,
  key: string,
  exceptMetricId: string | undefined,
): Promise<boolean> {
  const rows = await deps.repo.experiments.metrics.findMany(scope);
  return rows.some((row) => row.key === key && row.id !== exceptMetricId);
}

function metricPatch(
  body: Record<string, unknown>,
  prepared: PreparedMetricWrite,
): Parameters<Repository["experiments"]["updateMetric"]>[2] {
  return {
    ...(body.key !== undefined ? { key: body.key as string } : {}),
    ...(body.name !== undefined ? { name: body.name as string } : {}),
    ...(body.description !== undefined ? { description: body.description as string } : {}),
    ...(body.eventName !== undefined ? { eventName: prepared.eventName } : {}),
    ...(body.eventValueField !== undefined ? { eventValueField: prepared.eventValueField } : {}),
    ...(body.denominator !== undefined
      ? { denominatorMetricId: prepared.denominatorMetricId }
      : {}),
  };
}

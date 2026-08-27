import { appScope } from "@splitch/db";
import type { HandlerArgs } from "@splitch/worker-runtime";
import { appNotFound, nowIso } from "./app-environment-model";
import { randomHex } from "./credential-cache";
import { runningExperimentError, validationError } from "./flag-definition-errors";
import { objectBody, pathParam } from "./handler-input";
import { metricPatch, prepareMetricWrite } from "./metric-write";
import {
  decisionLockedError,
  type MetricSegmentDeps,
  metricFromPath,
  metricNotFound,
  metricResponse,
  requireWritableApp,
  runningMetricReference,
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
  const writeError = await requireWritableApp(deps, appId, principal, requestId);
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
    eventDefinitionId: prepared.value.eventDefinitionId,
    eventFieldName: prepared.value.eventFieldName,
    numeratorMetricId: prepared.value.numeratorMetricId,
    denominatorMetricId: prepared.value.denominatorMetricId,
    ...prepared.value.analysis,
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

  const writeError = await requireWritableApp(deps, appId, args.principal, args.requestId);
  if (writeError) return writeError;

  const body = objectBody(args.input);
  const blocker = await runningMetricReference(deps, appId, metric.id);
  if (blocker) return decisionLockedError(blocker, Object.keys(body), args.requestId);

  const prepared = await prepareMetricWrite(deps, appScope(appId), metric, body, args.requestId);
  if (!prepared.ok) return prepared.response;

  const patch = metricPatch(body, prepared.value, metric);
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

  const writeError = await requireWritableApp(deps, appId, args.principal, args.requestId);
  if (writeError) return writeError;

  const blocker = await runningMetricReference(deps, appId, metric.id);
  if (blocker) return runningExperimentError(blocker, "DELETE_METRIC", args.requestId);

  await deps.repo.experiments.removeMetric(appScope(appId), metric.id);
  return Response.json({ deleted: true });
}

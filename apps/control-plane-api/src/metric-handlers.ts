import { type MetricKind, type MetricRef } from "@splitch/contracts";
import { appScope, type Repository, type TenantScope } from "@splitch/db";
import type { HandlerArgs } from "@splitch/worker-runtime";
import { nowIso } from "./app-environment-model";
import { randomHex } from "./credential-cache";
import { runningExperimentError, validationError } from "./flag-definition-errors";
import { objectBody, pathParam } from "./handler-input";
import { listMetrics } from "./metric-list-handler";
import {
  type MetricAnalysisConfig,
  metricAnalysisConfig,
  metricAnalysisIssue,
  metricAnalysisPatch,
} from "./metric-analysis-config";
import {
  decisionLockedError,
  fail,
  type MetricRow,
  type MetricSegmentDeps,
  metricFromPath,
  metricNotFound,
  metricResponse,
  ok,
  type Result,
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

  const writeError = await requireWritableApp(deps, appId, args.principal, args.requestId);
  if (writeError) return writeError;

  const blocker = await runningMetricReference(deps, appId, metric.id);
  if (blocker) return runningExperimentError(blocker, "DELETE_METRIC", args.requestId);

  await deps.repo.experiments.removeMetric(appScope(appId), metric.id);
  return Response.json({ deleted: true });
}

interface PreparedMetricWrite {
  kind: MetricKind;
  eventDefinitionId: string;
  eventFieldName: string | null;
  denominatorMetricId: string | null;
  analysis: MetricAnalysisConfig;
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
    eventDefinitionId: (body.eventDefinitionId ?? current?.eventDefinitionId) as string,
    eventFieldName: metricField(body, current),
    denominatorMetricId: metricDenominator(body, current),
    analysis: metricAnalysisConfig(body, current),
  };
  return (await validateMetricShape(deps, scope, current, prepared, requestId)) ?? ok(prepared);
}

function metricField(body: Record<string, unknown>, current: MetricRow | null): string | null {
  return body.eventFieldName !== undefined
    ? (body.eventFieldName as string)
    : (current?.eventFieldName ?? null);
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
  current: MetricRow | null,
  prepared: PreparedMetricWrite,
  requestId: string,
): Promise<Result<never> | null> {
  const shapeIssue = metricShapeIssue(prepared, current?.id, requestId);
  if (shapeIssue) return fail(shapeIssue);
  const definition = await deps.repo.eventDefinitions.get(scope, prepared.eventDefinitionId);
  if (definition?.family !== "metric") {
    return fail(
      metricIssue(
        requestId,
        "eventDefinitionId",
        "Metric requires a metric Event Definition in this App",
      ),
    );
  }
  if (!definition.currentPublishedVersionId) {
    if (
      definition.state === "incomplete" &&
      current?.eventDefinitionId === prepared.eventDefinitionId &&
      current.eventFieldName === prepared.eventFieldName
    ) {
      return validateDenominator(deps, scope, prepared, requestId);
    }
    return fail(
      metricIssue(requestId, "eventDefinitionId", "Metric requires a published Event Definition"),
    );
  }
  const version = await deps.repo.eventDefinitions.getVersion(
    scope,
    definition.id,
    definition.currentPublishedVersionId,
  );
  if (!version) throw new Error("Metric Event Definition points to a missing Version");
  const fields = JSON.parse(version.fields) as Array<{ name: string }>;
  if (prepared.eventFieldName && !fields.some(({ name }) => name === prepared.eventFieldName)) {
    return fail(
      metricIssue(
        requestId,
        "eventFieldName",
        "Metric field must be declared by the Event Definition Version",
      ),
    );
  }
  return validateDenominator(deps, scope, prepared, requestId);
}

async function validateDenominator(
  deps: MetricSegmentDeps,
  scope: TenantScope,
  prepared: PreparedMetricWrite,
  requestId: string,
): Promise<Result<never> | null> {
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
  const valueFieldIssue = metricValueFieldIssue(prepared, requestId);
  if (valueFieldIssue) return valueFieldIssue;
  const denominatorIssue = metricDenominatorIssue(prepared, metricId, requestId);
  if (denominatorIssue) return denominatorIssue;
  const analysisIssue = metricAnalysisIssue(prepared.kind, prepared.analysis);
  if (analysisIssue) return metricIssue(requestId, analysisIssue.field, analysisIssue.message);
  return null;
}

function metricValueFieldIssue(prepared: PreparedMetricWrite, requestId: string): Response | null {
  if ((prepared.kind === "count" || prepared.kind === "revenue") && !prepared.eventFieldName) {
    return metricIssue(
      requestId,
      "eventFieldName",
      `${prepared.kind} Metric requires eventFieldName`,
    );
  }
  if (prepared.kind === "binomial" && prepared.eventFieldName) {
    return metricIssue(requestId, "eventFieldName", "binomial Metric cannot set eventFieldName");
  }
  return null;
}

function metricDenominatorIssue(
  prepared: PreparedMetricWrite,
  metricId: string | undefined,
  requestId: string,
): Response | null {
  if (prepared.kind === "ratio" && !prepared.denominatorMetricId) {
    return metricIssue(requestId, "denominator", "ratio Metric requires denominator");
  }
  if (prepared.kind !== "ratio" && prepared.denominatorMetricId) {
    return metricIssue(requestId, "denominator", "only ratio Metrics may set denominator");
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
    ...(body.eventDefinitionId !== undefined
      ? { eventDefinitionId: prepared.eventDefinitionId }
      : {}),
    ...(body.eventFieldName !== undefined ? { eventFieldName: prepared.eventFieldName } : {}),
    ...(body.denominator !== undefined
      ? { denominatorMetricId: prepared.denominatorMetricId }
      : {}),
    ...metricAnalysisPatch(body, prepared.analysis),
  };
}

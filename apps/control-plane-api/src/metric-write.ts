import type { MetricKind, MetricRef } from "@splitch/contracts";
import type { Repository, TenantScope } from "@splitch/db";
import { validationError } from "./flag-definition-errors";
import {
  type MetricAnalysisConfig,
  metricAnalysisConfig,
  metricAnalysisIssue,
  metricAnalysisPatch,
} from "./metric-analysis-config";
import {
  fail,
  type MetricRow,
  type MetricSegmentDeps,
  ok,
  type Result,
} from "./metric-segment-shared";

export interface PreparedMetricWrite {
  kind: MetricKind;
  eventDefinitionId: string | null;
  eventFieldName: string | null;
  numeratorMetricId: string | null;
  denominatorMetricId: string | null;
  analysis: MetricAnalysisConfig;
}

type MetricPatch = Parameters<Repository["experiments"]["updateMetric"]>[2];

export async function prepareMetricWrite(
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

  const kind = (current?.kind ?? body.kind) as MetricKind;
  const prepared = {
    kind,
    eventDefinitionId: directBinding(body, "eventDefinitionId", kind, current),
    eventFieldName: directBinding(body, "eventFieldName", kind, current),
    numeratorMetricId: metricOperand(body, "numerator", current?.numeratorMetricId ?? null),
    denominatorMetricId: metricOperand(body, "denominator", current?.denominatorMetricId ?? null),
    analysis: metricAnalysisConfig(body, current),
  };
  return (await validateMetricShape(deps, scope, current, prepared, requestId)) ?? ok(prepared);
}

export function metricPatch(
  body: Record<string, unknown>,
  prepared: PreparedMetricWrite,
  current: MetricRow,
): MetricPatch {
  const patch: MetricPatch = metricAnalysisPatch(body, prepared.analysis);
  copyTextFields(body, patch);
  copyDirectBinding(body, patch, prepared, current);
  copyOperands(body, patch, prepared);
  return patch;
}

function copyTextFields(body: Record<string, unknown>, patch: MetricPatch): void {
  if (body.key !== undefined) patch.key = body.key as string;
  if (body.name !== undefined) patch.name = body.name as string;
  if (body.description !== undefined) patch.description = body.description as string;
}

function copyDirectBinding(
  body: Record<string, unknown>,
  patch: MetricPatch,
  prepared: PreparedMetricWrite,
  current: MetricRow,
): void {
  const clearsLegacyBinding = prepared.kind === "ratio";
  if (body.eventDefinitionId !== undefined || (clearsLegacyBinding && current.eventDefinitionId)) {
    patch.eventDefinitionId = prepared.eventDefinitionId;
  }
  if (body.eventFieldName !== undefined || (clearsLegacyBinding && current.eventFieldName)) {
    patch.eventFieldName = prepared.eventFieldName;
  }
}

function copyOperands(
  body: Record<string, unknown>,
  patch: MetricPatch,
  prepared: PreparedMetricWrite,
): void {
  if (body.numerator !== undefined) patch.numeratorMetricId = prepared.numeratorMetricId;
  if (body.denominator !== undefined) patch.denominatorMetricId = prepared.denominatorMetricId;
}

function directBinding(
  body: Record<string, unknown>,
  field: "eventDefinitionId" | "eventFieldName",
  kind: MetricKind,
  current: MetricRow | null,
): string | null {
  if (body[field] !== undefined) return body[field] as string | null;
  if (kind === "ratio") return null;
  return current?.[field] ?? null;
}

function metricOperand(
  body: Record<string, unknown>,
  field: "numerator" | "denominator",
  current: string | null,
): string | null {
  if (body[field] === undefined) return current;
  return ((body[field] as MetricRef | null)?.metricId ?? null) as string | null;
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
  if (prepared.kind === "ratio") return validateRatioOperands(deps, scope, prepared, requestId);
  return validateDirectMetricBinding(deps, scope, current, prepared, requestId);
}

async function validateDirectMetricBinding(
  deps: MetricSegmentDeps,
  scope: TenantScope,
  current: MetricRow | null,
  prepared: PreparedMetricWrite,
  requestId: string,
): Promise<Result<never> | null> {
  if (!prepared.eventDefinitionId) {
    throw new Error(`Metric ${current?.id ?? "create"} has no Event Definition after validation`);
  }
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
      return null;
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
  const field = (JSON.parse(version.fields) as Array<{ name: string; type: string }>).find(
    ({ name }) => name === prepared.eventFieldName,
  );
  if (prepared.eventFieldName && field?.type !== "number") {
    return fail(
      metricIssue(
        requestId,
        "eventFieldName",
        "Metric field must be a declared number on the Event Definition Version",
      ),
    );
  }
  return null;
}

async function validateRatioOperands(
  deps: MetricSegmentDeps,
  scope: TenantScope,
  prepared: PreparedMetricWrite,
  requestId: string,
): Promise<Result<never> | null> {
  const operands = [
    ["numerator", prepared.numeratorMetricId],
    ["denominator", prepared.denominatorMetricId],
  ] as const;
  for (const [field, metricId] of operands) {
    const operand = metricId ? await deps.repo.experiments.getMetric(scope, metricId) : null;
    if (!operand)
      return fail(metricIssue(requestId, field, `${field} Metric must belong to this App`));
    if (operand.kind === "ratio") {
      return fail(metricIssue(requestId, field, `${field} Metric must be non-Ratio`));
    }
  }
  return null;
}

function metricShapeIssue(
  prepared: PreparedMetricWrite,
  metricId: string | undefined,
  requestId: string,
): Response | null {
  const bindingIssue = metricBindingIssue(prepared, requestId);
  if (bindingIssue) return bindingIssue;
  const operandIssue = metricOperandIssue(prepared, metricId, requestId);
  if (operandIssue) return operandIssue;
  const analysisIssue = metricAnalysisIssue(prepared.kind, prepared.analysis);
  return analysisIssue ? metricIssue(requestId, analysisIssue.field, analysisIssue.message) : null;
}

function metricBindingIssue(prepared: PreparedMetricWrite, requestId: string): Response | null {
  if ((prepared.kind === "count" || prepared.kind === "revenue") && !prepared.eventFieldName) {
    return metricIssue(
      requestId,
      "eventFieldName",
      `${prepared.kind} Metric requires eventFieldName`,
    );
  }
  if ((prepared.kind === "binomial" || prepared.kind === "ratio") && prepared.eventFieldName) {
    return metricIssue(
      requestId,
      "eventFieldName",
      `${prepared.kind} Metric cannot set eventFieldName`,
    );
  }
  if (prepared.kind === "ratio" && prepared.eventDefinitionId) {
    return metricIssue(requestId, "eventDefinitionId", "ratio Metric cannot set eventDefinitionId");
  }
  if (prepared.kind !== "ratio" && !prepared.eventDefinitionId) {
    return metricIssue(
      requestId,
      "eventDefinitionId",
      `${prepared.kind} Metric requires eventDefinitionId`,
    );
  }
  return null;
}

function metricOperandIssue(
  prepared: PreparedMetricWrite,
  metricId: string | undefined,
  requestId: string,
): Response | null {
  if (prepared.kind !== "ratio") {
    return prepared.numeratorMetricId || prepared.denominatorMetricId
      ? metricIssue(requestId, "numerator", "only ratio Metrics may set operands")
      : null;
  }
  if (!prepared.numeratorMetricId) {
    return metricIssue(requestId, "numerator", "ratio Metric requires numerator");
  }
  if (!prepared.denominatorMetricId) {
    return metricIssue(requestId, "denominator", "ratio Metric requires denominator");
  }
  if (prepared.numeratorMetricId === prepared.denominatorMetricId) {
    return metricIssue(requestId, "denominator", "ratio Metric operands must be distinct");
  }
  if (prepared.numeratorMetricId === metricId || prepared.denominatorMetricId === metricId) {
    return metricIssue(requestId, "denominator", "Metric cannot use itself as an operand");
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

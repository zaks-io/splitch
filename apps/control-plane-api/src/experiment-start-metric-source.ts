import type { Repository } from "@splitch/db";
import { experimentStartInvalid } from "./experiment-errors";

export type MetricRow = NonNullable<Awaited<ReturnType<Repository["experiments"]["getMetric"]>>>;
export type EventDefinitionVersion = NonNullable<
  Awaited<ReturnType<Repository["eventDefinitions"]["getVersion"]>>
>;
export type PublishedSource = Awaited<
  ReturnType<Repository["eventDefinitions"]["listCurrentPublishedVersions"]>
>[number];
export type Result<T> = { ok: true; value: T } | { ok: false; response: Response };

export function sourceEventDefinitionVersion(
  sources: Map<string, PublishedSource>,
  row: MetricRow,
  analyzedMetricId: string,
  requestId: string,
): Result<EventDefinitionVersion> {
  if (!row.eventDefinitionId) {
    return invalidMetric(
      analyzedMetricId,
      `source Metric ${row.id} has no Event Definition`,
      requestId,
    );
  }
  const source = sources.get(row.eventDefinitionId);
  const definition = source?.definition;
  if (definition?.family !== "metric" || !definition.currentPublishedVersionId) {
    return invalidMetric(
      analyzedMetricId,
      `source Metric ${row.id} has no current published metric Event Definition`,
      requestId,
    );
  }
  const version = source?.version;
  if (!version) {
    return invalidMetric(
      analyzedMetricId,
      `Event Definition ${definition.id} has a stale Version`,
      requestId,
    );
  }
  return { ok: true, value: version };
}

export function sourceVersionIssue(
  row: MetricRow,
  version: EventDefinitionVersion,
  targetingKeyType: string,
  analyzedMetricId: string,
  requestId: string,
): Result<never> | null {
  if (version.entityType !== targetingKeyType) {
    return invalidMetric(
      analyzedMetricId,
      `source Metric ${row.id} Entity type ${version.entityType ?? "null"} does not match Run Entity type ${targetingKeyType}`,
      requestId,
    );
  }
  if (row.kind === "count" || row.kind === "revenue") {
    const fields = JSON.parse(version.fields) as Array<{ name: string; type: string }>;
    const field = fields.find(({ name }) => name === row.eventFieldName);
    if (field?.type !== "number") {
      return invalidMetric(
        analyzedMetricId,
        `source Metric ${row.id} field ${row.eventFieldName ?? "null"} is missing or nonnumeric`,
        requestId,
      );
    }
  }
  return null;
}

export function invalidMetric<T>(metricId: string, message: string, requestId: string): Result<T> {
  return {
    ok: false,
    response: experimentStartInvalid(
      [{ path: ["body", "metrics", metricId], message: `Metric ${metricId} ${message}` }],
      requestId,
    ),
  };
}

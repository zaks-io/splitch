import {
  DEFAULT_CUPED_LOOKBACK_MS,
  MetricKindSchema,
  type MetricQueryConfig,
} from "@splitch/contracts";
import { appScope, type Repository } from "@splitch/db";
import { experimentStartInvalid } from "./experiment-errors";

type MetricRow = NonNullable<Awaited<ReturnType<Repository["experiments"]["getMetric"]>>>;
type EventDefinitionVersion = NonNullable<
  Awaited<ReturnType<Repository["eventDefinitions"]["getVersion"]>>
>;
type PublishedSource = Awaited<
  ReturnType<Repository["eventDefinitions"]["listCurrentPublishedVersions"]>
>[number];
type Result<T> = { ok: true; value: T } | { ok: false; response: Response };
type SourceBinding = Extract<MetricQueryConfig, { metric_type: "ratio" }>["numerator"];

export async function frozenMetricQueryConfig(
  repo: Repository,
  appId: string,
  rows: Map<string, MetricRow>,
  metricIds: string[],
  conversionWindowMs: number,
  targetingKeyType: string,
  requestId: string,
): Promise<Result<MetricQueryConfig[]>> {
  const operandIds = [...rows.values()].flatMap((row) =>
    row.kind === "ratio"
      ? [row.numeratorMetricId, row.denominatorMetricId].filter((id): id is string => id !== null)
      : [],
  );
  const unloadedOperandIds = [...new Set(operandIds)].filter((id) => !rows.has(id));
  const operands = await repo.experiments.listMetricsByIds(appScope(appId), unloadedOperandIds);
  for (const operand of operands) rows.set(operand.id, operand);

  const sourceDefinitionIds = [
    ...new Set(
      [...rows.values()]
        .filter((row) => row.kind !== "ratio")
        .map((row) => row.eventDefinitionId)
        .filter((id): id is string => id !== null),
    ),
  ];
  const publishedSources = await repo.eventDefinitions.listCurrentPublishedVersions(
    appScope(appId),
    sourceDefinitionIds,
  );
  const sources = new Map(publishedSources.map((source) => [source.definition.id, source]));

  const configs: MetricQueryConfig[] = [];
  for (const metricId of metricIds) {
    const config = queryConfig(
      rows,
      sources,
      metricId,
      conversionWindowMs,
      targetingKeyType,
      requestId,
    );
    if (!config.ok) return config;
    configs.push(config.value);
  }
  return { ok: true, value: configs };
}

function queryConfig(
  rows: Map<string, MetricRow>,
  sources: Map<string, PublishedSource>,
  metricId: string,
  conversionWindowMs: number,
  targetingKeyType: string,
  requestId: string,
): Result<MetricQueryConfig> {
  const row = rows.get(metricId);
  if (!row) throw new Error(`prepareStart: Metric ${metricId} was not loaded`);
  if (row.kind === "ratio") {
    return ratioQueryConfig(rows, sources, row, conversionWindowMs, targetingKeyType, requestId);
  }
  if (!row.eventDefinitionId) {
    return invalidMetric(metricId, "has no Event Definition", requestId);
  }
  const metricType = MetricKindSchema.parse(row.kind);
  if (metricType === "ratio") {
    throw new Error(`prepareStart: Ratio Metric ${metricId} escaped its branch`);
  }
  if (metricType === "count" || metricType === "revenue") {
    const source = sourceBinding(sources, row, targetingKeyType, metricId, requestId);
    if (!source.ok) return source;
    return {
      ok: true,
      value: {
        ...source.value,
        metric_id: metricId,
        window_duration_ms: conversionWindowMs,
        cuped_lookback_ms: DEFAULT_CUPED_LOOKBACK_MS,
      },
    };
  }
  return {
    ok: true,
    value: {
      metric_id: metricId,
      metric_type: "binomial",
      event_definition_id: row.eventDefinitionId,
      event_field_name: null,
      window_duration_ms: conversionWindowMs,
      cuped_lookback_ms: DEFAULT_CUPED_LOOKBACK_MS,
    },
  };
}

function ratioQueryConfig(
  rows: Map<string, MetricRow>,
  sources: Map<string, PublishedSource>,
  row: MetricRow,
  conversionWindowMs: number,
  targetingKeyType: string,
  requestId: string,
): Result<MetricQueryConfig> {
  const numerator = ratioOperandBinding(
    rows,
    sources,
    row.numeratorMetricId,
    "numerator",
    targetingKeyType,
    row.id,
    requestId,
  );
  if (!numerator.ok) return numerator;
  const denominator = ratioOperandBinding(
    rows,
    sources,
    row.denominatorMetricId,
    "denominator",
    targetingKeyType,
    row.id,
    requestId,
  );
  if (!denominator.ok) return denominator;
  if (numerator.value.metric_id === denominator.value.metric_id) {
    return invalidMetric(row.id, "ratio operands must be distinct Metrics", requestId);
  }
  return {
    ok: true,
    value: {
      metric_id: row.id,
      metric_type: "ratio",
      numerator: numerator.value,
      denominator: denominator.value,
      window_duration_ms: conversionWindowMs,
      cuped_lookback_ms: DEFAULT_CUPED_LOOKBACK_MS,
    },
  };
}

function ratioOperandBinding(
  rows: Map<string, MetricRow>,
  sources: Map<string, PublishedSource>,
  operandId: string | null,
  name: "numerator" | "denominator",
  targetingKeyType: string,
  ratioMetricId: string,
  requestId: string,
): Result<SourceBinding> {
  if (!operandId) return invalidMetric(ratioMetricId, `has no ${name} Metric`, requestId);
  const operand = rows.get(operandId);
  if (!operand) {
    return invalidMetric(
      ratioMetricId,
      `${name} Metric ${operandId} is missing or cross-App`,
      requestId,
    );
  }
  if (operand.kind === "ratio") {
    return invalidMetric(ratioMetricId, `${name} Metric ${operandId} is itself a Ratio`, requestId);
  }
  return sourceBinding(sources, operand, targetingKeyType, ratioMetricId, requestId);
}

function sourceBinding(
  sources: Map<string, PublishedSource>,
  row: MetricRow,
  targetingKeyType: string,
  analyzedMetricId: string,
  requestId: string,
): Result<SourceBinding> {
  const version = sourceEventDefinitionVersion(sources, row, analyzedMetricId, requestId);
  if (!version.ok) return version;
  const versionIssue = sourceVersionIssue(
    row,
    version.value,
    targetingKeyType,
    analyzedMetricId,
    requestId,
  );
  if (versionIssue) return versionIssue;
  return sourceBindingValue(row);
}

function sourceEventDefinitionVersion(
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

function sourceVersionIssue(
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

function sourceBindingValue(row: MetricRow): Result<SourceBinding> {
  if (!row.eventDefinitionId) {
    throw new Error(`prepareStart: source Metric ${row.id} lost its Event Definition`);
  }
  if (row.kind === "binomial") {
    return {
      ok: true,
      value: {
        metric_id: row.id,
        metric_type: "binomial",
        event_definition_id: row.eventDefinitionId,
        event_field_name: null,
      },
    };
  }
  if (!row.eventFieldName) {
    throw new Error(`prepareStart: source Metric ${row.id} lost its numeric field`);
  }
  return {
    ok: true,
    value: {
      metric_id: row.id,
      metric_type: row.kind as "count" | "revenue",
      event_definition_id: row.eventDefinitionId,
      event_field_name: row.eventFieldName,
    },
  };
}

function invalidMetric<T>(metricId: string, message: string, requestId: string): Result<T> {
  return {
    ok: false,
    response: experimentStartInvalid(
      [{ path: ["body", "metrics", metricId], message: `Metric ${metricId} ${message}` }],
      requestId,
    ),
  };
}

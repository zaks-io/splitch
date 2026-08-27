import {
  DEFAULT_CUPED_LOOKBACK_MS,
  type MetricQueryConfig,
  MetricKindSchema,
} from "@splitch/contracts";
import { appScope, type Repository } from "@splitch/db";
import { experimentStartInvalid } from "./experiment-errors";

type MetricRow = NonNullable<Awaited<ReturnType<Repository["experiments"]["getMetric"]>>>;
type EventDefinitionVersion = NonNullable<
  Awaited<ReturnType<Repository["eventDefinitions"]["getVersion"]>>
>;
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
  const configs: MetricQueryConfig[] = [];
  for (const metricId of metricIds) {
    const config = await queryConfig(
      repo,
      appId,
      rows,
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

async function queryConfig(
  repo: Repository,
  appId: string,
  rows: Map<string, MetricRow>,
  metricId: string,
  conversionWindowMs: number,
  targetingKeyType: string,
  requestId: string,
): Promise<Result<MetricQueryConfig>> {
  const row = rows.get(metricId);
  if (!row) throw new Error(`prepareStart: Metric ${metricId} was not loaded`);
  if (row.kind === "ratio") {
    return ratioQueryConfig(repo, appId, row, conversionWindowMs, targetingKeyType, requestId);
  }
  if (!row.eventDefinitionId) {
    return invalidMetric(metricId, "has no Event Definition", requestId);
  }
  const metricType = MetricKindSchema.parse(row.kind);
  if (metricType === "ratio") {
    throw new Error(`prepareStart: Ratio Metric ${metricId} escaped its branch`);
  }
  if (metricType === "count" || metricType === "revenue") {
    const source = await sourceBinding(repo, appId, row, targetingKeyType, metricId, requestId);
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

async function ratioQueryConfig(
  repo: Repository,
  appId: string,
  row: MetricRow,
  conversionWindowMs: number,
  targetingKeyType: string,
  requestId: string,
): Promise<Result<MetricQueryConfig>> {
  const numerator = await ratioOperandBinding(
    repo,
    appId,
    row.numeratorMetricId,
    "numerator",
    targetingKeyType,
    row.id,
    requestId,
  );
  if (!numerator.ok) return numerator;
  const denominator = await ratioOperandBinding(
    repo,
    appId,
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

async function ratioOperandBinding(
  repo: Repository,
  appId: string,
  operandId: string | null,
  name: "numerator" | "denominator",
  targetingKeyType: string,
  ratioMetricId: string,
  requestId: string,
): Promise<Result<SourceBinding>> {
  if (!operandId) return invalidMetric(ratioMetricId, `has no ${name} Metric`, requestId);
  const operand = await repo.experiments.getMetric(appScope(appId), operandId);
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
  return sourceBinding(repo, appId, operand, targetingKeyType, ratioMetricId, requestId);
}

async function sourceBinding(
  repo: Repository,
  appId: string,
  row: MetricRow,
  targetingKeyType: string,
  analyzedMetricId: string,
  requestId: string,
): Promise<Result<SourceBinding>> {
  const version = await sourceEventDefinitionVersion(repo, appId, row, analyzedMetricId, requestId);
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

async function sourceEventDefinitionVersion(
  repo: Repository,
  appId: string,
  row: MetricRow,
  analyzedMetricId: string,
  requestId: string,
): Promise<Result<EventDefinitionVersion>> {
  if (!row.eventDefinitionId) {
    return invalidMetric(
      analyzedMetricId,
      `source Metric ${row.id} has no Event Definition`,
      requestId,
    );
  }
  const definition = await repo.eventDefinitions.get(appScope(appId), row.eventDefinitionId);
  if (definition?.family !== "metric" || !definition.currentPublishedVersionId) {
    return invalidMetric(
      analyzedMetricId,
      `source Metric ${row.id} has no current published metric Event Definition`,
      requestId,
    );
  }
  const version = await repo.eventDefinitions.getVersion(
    appScope(appId),
    definition.id,
    definition.currentPublishedVersionId,
  );
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

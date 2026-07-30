import {
  ExperimentSchema,
  RunSchema,
  type Experiment,
  type MetricRef,
  type Run,
  type TargetingRule,
  type Variant,
} from "@splitch/contracts";
import type { Repository } from "@splitch/db";

export type ExperimentRow = NonNullable<
  Awaited<ReturnType<Repository["experiments"]["getExperiment"]>>
>;
export type RunRow = NonNullable<Awaited<ReturnType<Repository["experiments"]["getRun"]>>>;

export function experimentResponse(row: ExperimentRow): Experiment {
  return ExperimentSchema.parse({
    id: row.id,
    appId: row.appId,
    environmentId: row.environmentId,
    key: row.key,
    flagId: row.flagId,
    name: row.name,
    ...(row.description !== null ? { description: row.description } : {}),
    ...(row.hypothesis !== null ? { hypothesis: row.hypothesis } : {}),
    ...(row.owner !== null ? { owner: row.owner } : {}),
    tags: jsonArray<string>(row.tags),
    status: row.status,
    targetingKey: row.targetingKeyField,
    targetingKeyType: row.targetingKeyType,
    confidenceLevel: row.confidenceLevel,
    defaultVariantId: requiredString(row.defaultVariantId, "defaultVariantId"),
    metrics: jsonArray<MetricRef>(row.metrics),
    guardrailMetrics: jsonArray<MetricRef>(row.guardrailMetrics),
    activationMetricId: row.activationMetricId,
    conversionWindowMs: row.conversionWindowMs,
    dimensions: jsonArray<string>(row.dimensions),
    draftAllocation: jsonObject<Record<string, number>>(row.draftAllocation),
    draftSalt: row.draftSalt,
    draftTargetingRules: jsonArrayOrNull<TargetingRule>(row.draftTargetingRules),
    draftSegmentIds: jsonArrayOrNull<string>(row.draftSegmentIds),
    liveRunId: row.liveRunId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

export function runResponse(row: RunRow): Run {
  return RunSchema.parse({
    id: row.id,
    experimentId: row.experimentId,
    environmentId: row.environmentId,
    status: row.status,
    targetingKeyType: row.targetingKeyType,
    activationMetricId: row.activationMetricId,
    salt: row.salt,
    allocation: jsonObject<Record<string, number>>(row.allocation) ?? {},
    variantSet: jsonArray<Variant>(row.variantSet),
    targetingRules: jsonArray<TargetingRule>(row.targetingRules),
    configHash: row.configHash,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    createdAt: row.createdAt,
  });
}

export function jsonArray<T>(raw: string | null): T[] {
  if (!raw) return [];
  const parsed = JSON.parse(raw) as unknown;
  return Array.isArray(parsed) ? (parsed as T[]) : [];
}

export function jsonArrayOrNull<T>(raw: string | null): T[] | null {
  if (!raw) return null;
  return jsonArray<T>(raw);
}

export function jsonObject<T extends Record<string, unknown>>(raw: string | null): T | null {
  if (!raw) return null;
  const parsed = JSON.parse(raw) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as T) : null;
}

export function json(value: unknown): string {
  return JSON.stringify(value);
}

export async function runConfigHash(input: {
  salt: string;
  allocation: Record<string, number>;
  variantSet: Variant[];
  targetingRules: TargetingRule[];
}): Promise<string> {
  const bytes = new TextEncoder().encode(stableStringify(input));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function requiredString(value: string | null, field: string): string {
  if (!value) throw new Error(`Experiment is missing ${field}`);
  return value;
}

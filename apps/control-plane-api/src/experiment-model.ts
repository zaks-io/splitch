import {
  type Experiment,
  ExperimentSchema,
  ExperimentUpdateResponseSchema,
  type LiveRunUnaffected,
  type MetricRef,
  type PreRegistration,
  type PreRegistrationIntent,
  PreRegistrationSchema,
  type Run,
  RunResponseSchema,
  type TargetingRule,
  type Variant,
} from "@splitch/contracts";
import type { Repository } from "@splitch/db";
import { preRegistrationToIntent } from "./run-preregistration-resolve";

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

/**
 * Experiment PATCH response. When the write staged assignment fields under a
 * live Run, `liveRunUnaffected` names that Run and its frozen Targeting Rules
 * so the operator can tell the draft edit did not change evaluation (SPL-307).
 */
export function experimentUpdateResponse(
  row: ExperimentRow,
  liveRunUnaffected?: LiveRunUnaffected,
) {
  return ExperimentUpdateResponseSchema.parse({
    ...experimentResponse(row),
    ...(liveRunUnaffected ? { liveRunUnaffected } : {}),
  });
}

export function runResponse(
  row: RunRow,
  options?: { draftTargetingRules?: TargetingRule[] | null },
): Run & { draftTargetingRules?: TargetingRule[] | null } {
  const preRegistration = parsePreRegistrationIntent(row.preRegistration);
  return RunResponseSchema.parse({
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
    ...(preRegistration !== undefined ? { preRegistration } : {}),
    ...(options && "draftTargetingRules" in options
      ? { draftTargetingRules: options.draftTargetingRules ?? null }
      : {}),
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

/**
 * Recorded null means the Run never pre-registered. Empty string or a missing
 * column is refused rather than dropped, matching Analysis materialization so a
 * corrupted freeze cannot silently become "no pre-registration" on Run reads.
 */
export function parsePreRegistrationIntent(
  raw: string | null | undefined,
): PreRegistrationIntent | undefined {
  if (raw === null) return undefined;
  if (raw === undefined || raw === "") {
    throw new Error("Run pre_registration is empty; expected JSON or null (never registered)");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (cause) {
    throw new Error(
      `Run pre_registration is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  const parsed = PreRegistrationSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `Run pre_registration is invalid: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
    );
  }
  return preRegistrationToIntent(parsed.data satisfies PreRegistration);
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

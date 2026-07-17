import { type ErrorResponse, OrganizationUsageResponseSchema } from "@splitch/contracts";
import { renderError, type HandlerArgs } from "@splitch/worker-runtime";
import { scopedUsagePipeParams, TinybirdReadError, type TinybirdReadTransport } from "./tinybird";

const USAGE_PIPE = "analysis_evaluation_usage";

interface UsageScope {
  organizationId: string;
}

export interface UsageDeps {
  tinybird: TinybirdReadTransport;
  now?: () => Date;
}

export function makeUsageHandler(deps: UsageDeps) {
  return async ({ input, principal, requestId }: HandlerArgs<unknown>): Promise<Response> => {
    try {
      const scope = usageScope(input, principal.orgId);
      const period = currentMonth(deps.now?.() ?? new Date());
      const usage = await readUsageFromTinybird(deps.tinybird, scope, period);
      return Response.json(OrganizationUsageResponseSchema.parse(usage));
    } catch (cause) {
      return renderError(errorFor(cause), { requestId });
    }
  };
}

export async function readUsageFromTinybird(
  tinybird: TinybirdReadTransport,
  scope: UsageScope,
  period: UsagePeriod,
): Promise<ReturnType<typeof OrganizationUsageResponseSchema.parse>> {
  const rows = await tinybird.readPipe(
    USAGE_PIPE,
    scopedUsagePipeParams({
      organizationId: scope.organizationId,
      periodStart: period.startsAt,
      periodEnd: period.endsAt,
    }),
  );

  const aggregate = emptyAggregate();
  for (const row of rows) {
    const usageRow = materializeUsageRow(row, scope);
    aggregate.evaluations += usageRow.evaluations;
    addCount(aggregate.byApp, usageRow.appId, usageRow.evaluations);
    addCount(aggregate.byEnvironment, usageRow.environmentId, usageRow.evaluations);
    addCount(aggregate.byBatch, usageRow.mode, usageRow.evaluations);
    addCount(aggregate.bySource, usageRow.source, usageRow.evaluations);
    addCount(aggregate.byExposure, usageRow.exposure, usageRow.evaluations);
  }

  return {
    organizationId: scope.organizationId,
    period,
    state: aggregate.evaluations === 0 ? "zero" : "populated",
    evaluations: aggregate.evaluations,
    breakdown: {
      byApp: sortCounts(aggregate.byApp).map(([appId, evaluations]) => ({ appId, evaluations })),
      byEnvironment: sortCounts(aggregate.byEnvironment).map(([environmentId, evaluations]) => ({
        environmentId,
        evaluations,
      })),
      byBatch: sortCounts(aggregate.byBatch).map(([mode, evaluations]) => ({
        mode: mode as UsageMode,
        evaluations,
      })),
      bySource: sortCounts(aggregate.bySource).map(([source, evaluations]) => ({
        source: source as UsageSource,
        evaluations,
      })),
      byExposure: sortCounts(aggregate.byExposure).map(([exposure, evaluations]) => ({
        exposure: exposure as UsageExposure,
        evaluations,
      })),
    },
  };
}

export interface UsagePeriod {
  month: string;
  startsAt: string;
  endsAt: string;
}

export function currentMonth(now: Date): UsagePeriod {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const startsAt = new Date(Date.UTC(year, month, 1)).toISOString();
  const endsAt = new Date(Date.UTC(year, month + 1, 1)).toISOString();
  return {
    month: `${year}-${String(month + 1).padStart(2, "0")}`,
    startsAt,
    endsAt,
  };
}

function usageScope(input: unknown, principalOrganizationId: string | null): UsageScope {
  const root = rowObject(input);
  const params = rowObject(root.params);
  const organizationId = stringField(params, "orgId");
  if (principalOrganizationId !== organizationId) {
    throw new UsageForbiddenError("credential is not scoped to this organization");
  }
  return { organizationId };
}

function materializeUsageRow(row: unknown, scope: UsageScope): UsageRow {
  const source = rowObject(row);
  const organizationId = stringField(source, "organization_id");
  if (organizationId !== scope.organizationId) {
    throw new UsageIsolationError();
  }

  const mode = stringField(source, "batch_mode");
  const usageSource = stringField(source, "evaluation_source");
  const exposure = stringField(source, "exposure_state");
  if (!isUsageMode(mode) || !isUsageSource(usageSource) || !isUsageExposure(exposure)) {
    throw new Error("analysis-api: Tinybird returned an invalid usage dimension");
  }

  return {
    appId: stringField(source, "app_id"),
    environmentId: stringField(source, "environment_id"),
    mode,
    source: usageSource,
    exposure,
    evaluations: nonNegativeInteger(source.evaluations),
  };
}

function errorFor(cause: unknown): ErrorResponse {
  if (cause instanceof UsageForbiddenError) {
    return { code: "FORBIDDEN", message: cause.message, details: {} };
  }
  if (cause instanceof TinybirdReadError) {
    return {
      code: "SERVICE_UNAVAILABLE",
      message: "usage data is unavailable",
      details: { retryAfterMs: 30_000 },
    };
  }
  if (cause instanceof UsageIsolationError) {
    return {
      code: "INTERNAL_SERVER_ERROR",
      message: "usage isolation failure",
      details: {},
    };
  }
  return { code: "INTERNAL_SERVER_ERROR", message: "usage read failed", details: {} };
}

type UsageMode = "single" | "batch";
type UsageSource = "remote" | "cached";
type UsageExposure = "bearing" | "not_bearing";

interface UsageRow {
  appId: string;
  environmentId: string;
  mode: UsageMode;
  source: UsageSource;
  exposure: UsageExposure;
  evaluations: number;
}

interface UsageAggregate {
  evaluations: number;
  byApp: Map<string, number>;
  byEnvironment: Map<string, number>;
  byBatch: Map<UsageMode, number>;
  bySource: Map<UsageSource, number>;
  byExposure: Map<UsageExposure, number>;
}

function emptyAggregate(): UsageAggregate {
  return {
    evaluations: 0,
    byApp: new Map(),
    byEnvironment: new Map(),
    byBatch: new Map(),
    bySource: new Map(),
    byExposure: new Map(),
  };
}

function addCount<T extends string>(counts: Map<T, number>, key: T, value: number): void {
  counts.set(key, (counts.get(key) ?? 0) + value);
}

function sortCounts<T extends string>(counts: Map<T, number>): [T, number][] {
  return [...counts.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function rowObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("analysis-api: expected object");
  }
  return value as Record<string, unknown>;
}

function stringField(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`analysis-api: missing ${key}`);
  }
  return value;
}

function nonNegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("analysis-api: invalid usage count");
  }
  return value;
}

function isUsageMode(value: string): value is UsageMode {
  return value === "single" || value === "batch";
}

function isUsageSource(value: string): value is UsageSource {
  return value === "remote" || value === "cached";
}

function isUsageExposure(value: string): value is UsageExposure {
  return value === "bearing" || value === "not_bearing";
}

class UsageForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageForbiddenError";
  }
}

class UsageIsolationError extends Error {
  constructor() {
    super("Tinybird returned a row outside the requested Organization scope");
    this.name = "UsageIsolationError";
  }
}

export type { UsageScope };

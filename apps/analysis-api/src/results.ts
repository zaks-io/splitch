import {
  type ErrorResponse,
  type StatsEngine,
  StatsInputSchema,
  StatsOutputSchema,
  type StatsInput,
} from "@splitch/contracts";
import { StatsEngine as DefaultStatsEngine } from "@splitch/stats";
import { renderError, type HandlerArgs } from "@splitch/worker-runtime";
import { scopedPipeParams, TinybirdReadError, type TinybirdReadTransport } from "./tinybird.js";

const RUN_INPUTS_PIPE = "analysis_run_inputs";
const EXPOSURES_PIPE = "analysis_deduped_exposures";
const METRIC_VALUES_PIPE = "analysis_metric_values";
const PRE_PERIOD_PIPE = "analysis_pre_period_covariates";
const ACTIVATION_PIPE = "analysis_activation_rows";

interface ResultsDeps {
  tinybird: TinybirdReadTransport;
  statsEngine?: StatsEngine;
}

interface ResultsScope {
  appId: string;
  environmentId: string;
  experimentId: string;
  runId?: string;
}

export function makeResultsHandler(deps: ResultsDeps) {
  const statsEngine = deps.statsEngine ?? DefaultStatsEngine;

  return async ({ input, principal, requestId }: HandlerArgs<unknown>): Promise<Response> => {
    try {
      const scope = resultsScope(input, principal.appId, principal.environmentId);
      const statsInput = await readStatsInputFromTinybird(deps.tinybird, scope);
      const output = await statsEngine.analyze(statsInput);
      return Response.json(StatsOutputSchema.parse(output));
    } catch (cause) {
      return renderError(errorFor(cause), { requestId });
    }
  };
}

export async function readStatsInputFromTinybird(
  tinybird: TinybirdReadTransport,
  scope: ResultsScope,
): Promise<StatsInput> {
  const baseParams = scopedPipeParams(scope);
  const [runInput] = await pipeRows(tinybird, RUN_INPUTS_PIPE, baseParams);
  const run = materializeRunInput(runInput);
  const params = scopedPipeParams({ ...scope, runId: run.run_id });

  const [exposureRows, metricRows, prePeriodRows, activationRows] = await Promise.all([
    pipeRows(tinybird, EXPOSURES_PIPE, params),
    pipeRows(tinybird, METRIC_VALUES_PIPE, params),
    pipeRows(tinybird, PRE_PERIOD_PIPE, params),
    pipeRows(tinybird, ACTIVATION_PIPE, params),
  ]);

  const exposures = exposureRows.map((row) => materializeExposure(row, scope));
  const input = StatsInputSchema.parse({
    ...run,
    exposures,
    metric_values: metricRows.map(materializeMetricRow),
    ...(prePeriodRows.length > 0
      ? { pre_period_covariates: prePeriodRows.map((row) => rowObject(row)) }
      : {}),
    ...(activationRows.length > 0
      ? { activation_rows: activationRows.map(materializeActivationRow) }
      : {}),
  });

  return input;
}

async function pipeRows(
  tinybird: TinybirdReadTransport,
  pipeName: string,
  params: Record<string, string>,
): Promise<readonly unknown[]> {
  return tinybird.readPipe(pipeName, params);
}

function materializeRunInput(row: unknown): Omit<StatsInput, "exposures" | "metric_values"> {
  const source = rowObject(row);
  return compact({
    run_id: stringField(source, "run_id"),
    confidence_level: optionalNumber(source.confidence_level),
    horizon: optionalString(source.horizon),
    target_n: optionalNumber(source.target_n),
    sample_size_locked: optionalNumber(source.sample_size_locked),
    allocation: jsonField(source, "allocation"),
    control_variant: stringField(source, "control_variant"),
    decision_family: jsonField(source, "decision_family"),
    guardrail_decisions: jsonField(source, "guardrail_decisions") ?? [],
    dimensions: jsonField(source, "dimensions"),
  }) as Omit<StatsInput, "exposures" | "metric_values">;
}

function materializeExposure(row: unknown, scope: ResultsScope): Record<string, unknown> {
  const source = rowObject(row);
  const appId = stringField(source, "app_id");
  const environmentId = stringField(source, "environment_id");
  if (appId !== scope.appId || environmentId !== scope.environmentId) {
    throw new Error("Tinybird returned a row outside the requested App/Environment scope");
  }
  return {
    ...source,
    window_anchor: source.window_anchor ?? source.first_exposure_ts,
    dimension_values: jsonField(source, "dimension_values"),
  };
}

function materializeMetricRow(row: unknown): Record<string, unknown> {
  const source = rowObject(row);
  return {
    ...source,
    in_window: booleanField(source, "in_window"),
  };
}

function materializeActivationRow(row: unknown): Record<string, unknown> {
  const source = rowObject(row);
  return {
    ...source,
    counterfactual: booleanField(source, "counterfactual"),
    activated: booleanField(source, "activated"),
  };
}

function resultsScope(
  input: unknown,
  principalAppId: string | null,
  principalEnvironmentId: string | null,
): ResultsScope {
  const root = rowObject(input);
  const params = rowObject(root.params);
  const query = optionalObject(root.query);
  const body = optionalObject(root.body);
  const pathAppId = stringField(params, "appId");
  const appId = requiredContext(principalAppId, "app_id");
  if (pathAppId !== appId) {
    throw new Error("path app_id does not match the authenticated App context");
  }

  const pathEnvironmentId = stringField(params, "environmentId");
  const environmentId = principalEnvironmentId ?? pathEnvironmentId;
  if (environmentId !== pathEnvironmentId) {
    throw new Error("path environment_id does not match the authenticated Environment context");
  }

  return {
    appId,
    environmentId,
    experimentId: stringField(params, "experimentId"),
    runId: optionalString(body.runId ?? query.runId),
  };
}

function errorFor(cause: unknown): ErrorResponse {
  if (cause instanceof TinybirdReadError) {
    return {
      code: "SERVICE_UNAVAILABLE",
      message: "analysis data is unavailable",
      details: { retryAfterMs: 30_000 },
    };
  }
  if (cause instanceof Error && cause.message.includes("outside the requested App/Environment")) {
    return {
      code: "INTERNAL_SERVER_ERROR",
      message: "analysis isolation failure",
      details: {},
    };
  }
  return { code: "INTERNAL_SERVER_ERROR", message: "analysis failed", details: {} };
}

function rowObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("analysis-api: expected object");
  }
  return value as Record<string, unknown>;
}

function optionalObject(value: unknown): Record<string, unknown> {
  return value === undefined ? {} : rowObject(value);
}

function stringField(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`analysis-api: missing ${key}`);
  }
  return value;
}

function requiredContext(value: string | null, name: string): string {
  if (value === null || value.trim().length === 0) {
    throw new TinybirdReadError(`Tinybird pipe parameter ${name} is required`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function booleanField(source: Record<string, unknown>, key: string): boolean {
  const value = source[key];
  if (value === true || value === false) return value;
  if (value === 1) return true;
  if (value === 0) return false;
  throw new Error(`analysis-api: missing ${key}`);
}

function jsonField(source: Record<string, unknown>, key: string): unknown {
  const value = source[key];
  if (typeof value !== "string") {
    return value;
  }
  return JSON.parse(value) as unknown;
}

function compact<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter((entry) => entry[1] !== undefined),
  ) as Partial<T>;
}

export type { ResultsDeps, ResultsScope };

import {
  AnalysisResultsEnvelopeSchema,
  type ErrorResponse,
  type StatsEngine,
  type StatsInput,
  StatsInputSchema,
  StatsOutputSchema,
} from "@splitch/contracts";
import { StatsEngine as DefaultStatsEngine } from "@splitch/stats";
import { type HandlerArgs, renderError } from "@splitch/worker-runtime";
import {
  AnalysisIsolationError,
  AnalysisProvenanceError,
  ResultsForbiddenError,
  ResultsNotFoundError,
} from "./results-errors";
import {
  booleanField,
  compact,
  jsonField,
  optionalNumber,
  optionalObject,
  optionalString,
  requiredPrincipalContext,
  rowObject,
  stringField,
} from "./results-row-fields";
import { scopedPipeParams, TinybirdReadError, type TinybirdReadTransport } from "./tinybird";

const RUN_INPUTS_PIPE = "analysis_run_inputs";
const EXPOSURES_PIPE = "analysis_deduped_exposures";
// Metric Event ingest is not deployed yet; these pipes are empty scoped stubs
// (infra/tinybird/pipes/analysis_metric_values.pipe and
// analysis_pre_period_covariates.pipe). Calling missing pipes returned HTTP 404
// → SERVICE_UNAVAILABLE and hid valid Exposure-only early-Run results (SPL-290).
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
      return Response.json(
        AnalysisResultsEnvelopeSchema.parse({
          run_id: statsInput.run_id,
          control_variant: statsInput.control_variant,
          stats: StatsOutputSchema.parse(output),
        }),
      );
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
  const runInputs = await pipeRows(tinybird, RUN_INPUTS_PIPE, baseParams);
  const runInput = runInputs[0];
  if (runInput === undefined) {
    throw new ResultsNotFoundError(
      scope.runId === undefined ? "EXPERIMENT_NOT_FOUND" : "RUN_NOT_FOUND",
    );
  }
  const run = materializeRunInput(runInput);
  // Every downstream read is keyed on the Run the inputs pipe returned. If that
  // is not the Run the caller asked for, the response would carry one Run's
  // Exposures under another Run's identity, and no pooling guarantee upstream
  // could detect it. Refuse instead of mislabelling.
  if (scope.runId !== undefined && run.run_id !== scope.runId) {
    throw new AnalysisProvenanceError(
      `analysis_run_inputs returned Run ${run.run_id} for requested Run ${scope.runId}`,
    );
  }
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
    throw new AnalysisIsolationError();
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
  const appId = requiredPrincipalContext(principalAppId);
  if (pathAppId !== appId) {
    throw new ResultsForbiddenError("path app_id does not match the authenticated App context");
  }

  // ADR-0027: a control-plane token binds an App and SELECTS the Environment by
  // path within it, so an env-unbound principal legitimately names the path's
  // Environment. A credential that IS env-bound is held to it. Either way the App
  // check above is the tenant boundary, and both pipe reads below are keyed on
  // this pair.
  const environmentId = stringField(params, "environmentId");
  if (principalEnvironmentId !== null && principalEnvironmentId !== environmentId) {
    throw new ResultsForbiddenError(
      "path environment_id does not match the authenticated Environment context",
    );
  }

  return {
    appId,
    environmentId,
    experimentId: stringField(params, "experimentId"),
    runId: optionalString(body.runId ?? query.runId),
  };
}

function errorFor(cause: unknown): ErrorResponse {
  if (cause instanceof ResultsNotFoundError) {
    return { code: cause.code, message: cause.message, details: {} };
  }
  if (cause instanceof ResultsForbiddenError) {
    return { code: "FORBIDDEN", message: cause.message, details: {} };
  }
  if (cause instanceof TinybirdReadError) {
    return {
      code: "SERVICE_UNAVAILABLE",
      message: "analysis data is unavailable",
      details: { retryAfterMs: 30_000 },
    };
  }
  // A Run-provenance mismatch is a permanent integrity failure, not a blip.
  // Reporting it as retryable would invite a client to poll until a mislabelled
  // answer looked like a transient hiccup that had cleared.
  if (cause instanceof AnalysisProvenanceError) {
    return {
      code: "INTERNAL_SERVER_ERROR",
      message: "analysis run provenance mismatch",
      details: {},
    };
  }
  if (cause instanceof AnalysisIsolationError) {
    return {
      code: "INTERNAL_SERVER_ERROR",
      message: "analysis isolation failure",
      details: {},
    };
  }
  return { code: "INTERNAL_SERVER_ERROR", message: "analysis failed", details: {} };
}

export type { ResultsDeps, ResultsScope };

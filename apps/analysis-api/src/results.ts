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
  ResultsInputError,
  ResultsInsufficientDataError,
  ResultsNotFoundError,
} from "./results-errors";
import {
  booleanField,
  jsonField,
  optionalObject,
  optionalString,
  requiredPrincipalContext,
  rowObject,
  stringField,
} from "./results-row-fields";
import { assertAnalysisInputsPresent, materializeRunInput } from "./results-run-input";
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
          state: "ready",
          run_id: statsInput.run_id,
          control_variant: statsInput.control_variant,
          stats: StatsOutputSchema.parse(output),
        }),
      );
    } catch (cause) {
      // Early-Run collecting state: Exposures without Metric Events (or no
      // Exposures yet) is healthy, not invalid. Same `no_data` discriminator
      // as app-attention-rollup (SPL-290 / SPL-302).
      if (cause instanceof ResultsInsufficientDataError) {
        return Response.json(
          AnalysisResultsEnvelopeSchema.parse({
            state: "no_data",
            run_id: cause.runId,
            control_variant: cause.controlVariant,
            missing: cause.missing,
          }),
        );
      }
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
    // Analysis only sees Tinybird. Empty run-input rows mean "no Run inputs
    // here", not "no such Experiment" — Experiment existence is resolved on the
    // Control Plane before the hop (SPL-305). Claiming EXPERIMENT_NOT_FOUND
    // from this pipe alone conflated drafts with missing ids.
    throw new ResultsNotFoundError("RUN_NOT_FOUND");
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

  const exposureRows = await pipeRows(tinybird, EXPOSURES_PIPE, params);
  const exposures = exposureRows.map((row) => materializeExposure(row, scope));
  // An empty Exposure denominator is a healthy collecting state. Stop here so
  // a fresh Run does not query Metric pipes before any Entity can have a value.
  if (exposures.length === 0) {
    throw new ResultsInsufficientDataError("exposures", run.run_id, run.control_variant);
  }

  const hasAnalyzedMetrics =
    run.decision_family.length > 0 || (run.guardrail_decisions?.length ?? 0) > 0;
  const [metricRows, prePeriodRows, activationRows] = hasAnalyzedMetrics
    ? await Promise.all([
        pipeRows(tinybird, METRIC_VALUES_PIPE, params),
        pipeRows(tinybird, PRE_PERIOD_PIPE, params),
        pipeRows(tinybird, ACTIVATION_PIPE, params),
      ])
    : [[], [], await pipeRows(tinybird, ACTIVATION_PIPE, params)];
  const metric_values = metricRows.map(materializeMetricRow);
  assertAnalysisInputsPresent({
    run_id: run.run_id,
    control_variant: run.control_variant,
    decision_family: run.decision_family,
    exposures,
    metric_values,
  });

  const input = StatsInputSchema.parse({
    ...run,
    exposures,
    metric_values,
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
  if (cause instanceof ResultsInputError || isZodError(cause)) {
    return {
      code: "VALIDATION_ERROR",
      message: "analysis inputs failed schema validation",
      details: {
        issues: zodOrInputIssues(cause),
      },
    };
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
      details: { fault: cause.message },
    };
  }
  if (cause instanceof AnalysisIsolationError) {
    return {
      code: "INTERNAL_SERVER_ERROR",
      message: "analysis isolation failure",
      details: { fault: cause.message },
    };
  }
  return {
    code: "INTERNAL_SERVER_ERROR",
    message: "analysis failed",
    details: { fault: faultMessage(cause) },
  };
}

function zodOrInputIssues(
  cause: ResultsInputError | ZodLikeError,
): Array<{ path: string[]; message: string }> {
  if (cause instanceof ResultsInputError) {
    return [{ path: ["analysis_run_inputs"], message: cause.message }];
  }
  return cause.issues.map((issue) => ({
    path: issue.path.map(String),
    message: issue.message,
  }));
}

interface ZodLikeError {
  issues: Array<{ path: PropertyKey[]; message: string }>;
}

function isZodError(cause: unknown): cause is ZodLikeError {
  return (
    typeof cause === "object" &&
    cause !== null &&
    (cause as { name?: unknown }).name === "ZodError" &&
    Array.isArray((cause as { issues?: unknown }).issues)
  );
}

function faultMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message.length > 0) return cause.message;
  return "unexpected analysis failure";
}

export type { ResultsDeps, ResultsScope };

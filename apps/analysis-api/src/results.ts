import {
  AnalysisResultsEnvelopeSchema,
  type StatsEngine,
  type StatsInput,
  StatsInputSchema,
  StatsOutputSchema,
} from "@splitch/contracts";
import { canonicalizeAnalysisRows } from "@splitch/privacy";
import { StatsEngine as DefaultStatsEngine } from "@splitch/stats";
import { type HandlerArgs, renderError } from "@splitch/worker-runtime";
import { createResultToken } from "./result-token";
import { readResultsExposureRows, readResultsRunRows } from "./results-bootstrap";
import { readDownstreamAnalysisRows } from "./results-downstream-rows";
import { resultsErrorResponse } from "./results-error-response";
import {
  AnalysisIsolationError,
  AnalysisProvenanceError,
  ResultsForbiddenError,
  ResultsInputError,
  ResultsInsufficientDataError,
  ResultsNotFoundError,
} from "./results-errors";
import { assertMetricQueryCoverage } from "./results-metric-query";
import {
  booleanField,
  jsonField,
  optionalObject,
  optionalString,
  requiredPrincipalContext,
  rowObject,
  stringField,
} from "./results-row-fields";
import {
  assertAnalysisInputsPresent,
  materializeMetricQueryConfig,
  materializeRunInput,
} from "./results-run-input";
import { scopedPipeParams, type TinybirdReadTransport, tinybirdDateTime64 } from "./tinybird";

interface ResultsDeps {
  tinybird: TinybirdReadTransport;
  statsEngine?: StatsEngine;
}

interface ResultsScope {
  appId: string;
  environmentId: string;
  experimentId: string;
  runId?: string;
  dataWatermark?: string;
}

interface ResultsComputation {
  statsInput: StatsInput;
  runConfigHash: string;
  dataWatermark?: string;
}

export function makeResultsHandler(deps: ResultsDeps) {
  const statsEngine = deps.statsEngine ?? DefaultStatsEngine;

  return async ({ input, principal, requestId }: HandlerArgs<unknown>): Promise<Response> => {
    try {
      const scope = resultsScope(input, principal.appId, principal.environmentId);
      const computation = await readResultsComputationFromTinybird(deps.tinybird, scope);
      const { statsInput } = computation;
      const output = await statsEngine.analyze(statsInput);
      // Stats permits infinite confidence bounds in memory. JSON carries those
      // bounds as null, so hash the same parsed value the caller receives.
      const stats = StatsOutputSchema.parse(JSON.parse(JSON.stringify(output)));
      const evidence = computation.dataWatermark
        ? {
            data_watermark: computation.dataWatermark,
            result_token: await createResultToken({
              appId: scope.appId,
              environmentId: scope.environmentId,
              experimentId: scope.experimentId,
              runId: statsInput.run_id,
              runConfigHash: computation.runConfigHash,
              stats,
            }),
          }
        : {};
      return Response.json(
        AnalysisResultsEnvelopeSchema.parse({
          state: "ready",
          run_id: statsInput.run_id,
          control_variant: statsInput.control_variant,
          ...evidence,
          stats,
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
      return renderError(resultsErrorResponse(cause), { requestId });
    }
  };
}

export async function readStatsInputFromTinybird(
  tinybird: TinybirdReadTransport,
  scope: ResultsScope,
): Promise<StatsInput> {
  return (await readResultsComputationFromTinybird(tinybird, scope)).statsInput;
}

async function readResultsComputationFromTinybird(
  tinybird: TinybirdReadTransport,
  scope: ResultsScope,
): Promise<ResultsComputation> {
  const baseParams = {
    ...scopedPipeParams(scope),
    ...watermarkPipeParams(scope.dataWatermark),
  };
  const runInputs = await readResultsRunRows(tinybird, baseParams);
  const runInput = runInputs[0];
  if (runInput === undefined) {
    // Analysis only sees Tinybird. Empty run-input rows mean "no Run inputs
    // here", not "no such Experiment" — Experiment existence is resolved on the
    // Control Plane before the hop (SPL-305). Claiming EXPERIMENT_NOT_FOUND
    // from this pipe alone conflated drafts with missing ids.
    throw new ResultsNotFoundError("RUN_NOT_FOUND");
  }
  const run = materializeProvenancedRun(runInput, scope.runId);
  const runConfigHash = stringField(rowObject(runInput), "config_hash");
  const dataWatermark =
    scope.dataWatermark ??
    normalizeDataWatermark(optionalString(rowObject(runInput).data_watermark));
  const metricQueryConfig = materializeMetricQueryConfig(runInput);
  const params = {
    ...scopedPipeParams({ ...scope, runId: run.run_id }),
    ...watermarkPipeParams(dataWatermark),
  };

  const exposureRows = await readResultsExposureRows(tinybird, params);
  const exposures = canonicalizeAnalysisRows(
    exposureRows.map((row) => materializeExposure(row, scope)),
  );
  // An empty Exposure denominator is a healthy collecting state. Stop here so
  // a fresh Run does not query Metric pipes before any Entity can have a value.
  requireExposures(exposures, run.run_id, run.control_variant);

  const hasAnalyzedMetrics =
    run.decision_family.length > 0 || (run.guardrail_decisions?.length ?? 0) > 0;
  if (hasAnalyzedMetrics) assertMetricQueryCoverage(run, metricQueryConfig);
  const startedAt = stringField(rowObject(runInput), "started_at");
  const activationGated = optionalString(rowObject(runInput).activation_metric_id) !== undefined;
  // accepted_at bounds the scan; ingest_watermark_ts freezes membership. Keep
  // this after the watermark so a row accepted and ingested exactly on the
  // inclusive evidence edge is not removed by the accepted_at < to_ts filter.
  const toTs = tinybirdDateTime64(new Date().toISOString());
  const { metricRows, prePeriodRows, activationRows } = await readDownstreamAnalysisRows({
    tinybird,
    params,
    metricQueryConfig,
    startedAt,
    toTs,
    activationGated,
    hasAnalyzedMetrics,
  });
  const metric_values = canonicalizeAnalysisRows(metricRows.map(materializeMetricRow));
  assertAnalysisInputsPresent({
    run_id: run.run_id,
    control_variant: run.control_variant,
    decision_family: run.decision_family,
    exposures,
    metric_values,
    activation_rows: gatedActivationRows(activationGated, activationRows),
  });

  const input = StatsInputSchema.parse({
    ...run,
    exposures,
    metric_values,
    ...(prePeriodRows.length > 0
      ? {
          pre_period_covariates: canonicalizeAnalysisRows(
            prePeriodRows.map((row) => rowObject(row)),
          ),
        }
      : {}),
    ...(activationGated
      ? { activation_rows: canonicalizeAnalysisRows(activationRows.map(materializeActivationRow)) }
      : {}),
  });

  return { statsInput: input, runConfigHash, ...(dataWatermark ? { dataWatermark } : {}) };
}

function materializeProvenancedRun(runInput: unknown, requestedRunId: string | undefined) {
  const run = materializeRunInput(runInput);
  // Every downstream read is keyed on the Run the inputs pipe returned. Refuse
  // a mismatch before any of that Run's rows can be relabelled for the caller.
  if (requestedRunId !== undefined && run.run_id !== requestedRunId) {
    throw new AnalysisProvenanceError(
      `analysis_run_inputs returned Run ${run.run_id} for requested Run ${requestedRunId}`,
    );
  }
  return run;
}

function requireExposures(
  exposures: readonly unknown[],
  runId: string,
  controlVariant: string,
): void {
  if (exposures.length === 0) {
    throw new ResultsInsufficientDataError("exposures", runId, controlVariant);
  }
}

function watermarkPipeParams(dataWatermark: string | undefined): Record<string, string> {
  return dataWatermark === undefined
    ? {}
    : { ingest_watermark_ts: tinybirdDateTime64(dataWatermark) };
}

function normalizeDataWatermark(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const iso = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  if (!Number.isFinite(Date.parse(iso))) {
    throw new ResultsInputError("analysis_run_inputs.data_watermark is not a timestamp");
  }
  return iso;
}

function gatedActivationRows(
  activationGated: boolean,
  activationRows: readonly unknown[],
): readonly unknown[] | undefined {
  return activationGated ? activationRows : undefined;
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
    dataWatermark: optionalString(body.dataWatermark),
  };
}

export type { ResultsDeps, ResultsScope };

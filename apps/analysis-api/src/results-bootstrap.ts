import { ResultsInputError } from "./results-errors";
import { rowObject, stringField } from "./results-row-fields";
import type { PipeParams, TinybirdReadTransport } from "./tinybird";

const RUN_BOOTSTRAP_PIPE = "analysis_run_bootstrap";
const RUN_INPUTS_PIPE = "analysis_run_inputs";
const EXPOSURES_PIPE = "analysis_deduped_exposures";

interface ResultsBootstrap {
  runInputs: readonly unknown[];
  exposureRows: readonly unknown[];
}

async function readResultsBootstrap(
  tinybird: TinybirdReadTransport,
  params: PipeParams,
): Promise<ResultsBootstrap> {
  return splitBootstrapRows(await tinybird.readPipe(RUN_BOOTSTRAP_PIPE, params));
}

export async function readInitialResultsRows(
  tinybird: TinybirdReadTransport,
  runId: string | undefined,
  params: PipeParams,
): Promise<{ runInputs: readonly unknown[]; exposureRows?: readonly unknown[] }> {
  if (runId === undefined) {
    return { runInputs: await tinybird.readPipe(RUN_INPUTS_PIPE, params) };
  }
  return readResultsBootstrap(tinybird, params);
}

export function readResultsExposureRows(
  tinybird: TinybirdReadTransport,
  params: PipeParams,
  prefetched: readonly unknown[] | undefined,
): Promise<readonly unknown[]> {
  return prefetched === undefined
    ? tinybird.readPipe(EXPOSURES_PIPE, params)
    : Promise.resolve(prefetched);
}

function splitBootstrapRows(rows: readonly unknown[]): ResultsBootstrap {
  const runInputs: unknown[] = [];
  const exposureRows: unknown[] = [];
  for (const row of rows) {
    const source = rowObject(row);
    const rowType = stringField(source, "row_type");
    const payload = JSON.parse(stringField(source, "payload")) as unknown;
    if (rowType === "run") runInputs.push(bootstrapRunInput(payload));
    else if (rowType === "exposure") exposureRows.push(bootstrapExposure(payload));
    else throw new ResultsInputError(`analysis_run_bootstrap returned row type ${rowType}`);
  }
  if (runInputs.length > 1) {
    throw new ResultsInputError("analysis_run_bootstrap returned multiple Run rows");
  }
  return { runInputs, exposureRows };
}

function bootstrapRunInput(payload: unknown): Record<string, unknown> {
  if (!Array.isArray(payload) || payload.length !== 15) {
    throw new ResultsInputError("analysis_run_bootstrap returned a malformed Run payload");
  }
  const [
    run_id,
    confidence_level,
    horizon,
    target_n,
    sample_size_locked,
    allocation,
    control_variant,
    control_variant_id,
    activation_metric_id,
    decision_family,
    guardrail_decisions,
    metric_query_config,
    metric_variance_config,
    dimensions,
    started_at,
  ] = payload;
  return {
    run_id,
    confidence_level,
    horizon,
    target_n,
    sample_size_locked,
    allocation,
    control_variant,
    control_variant_id,
    activation_metric_id,
    decision_family,
    guardrail_decisions,
    metric_query_config,
    metric_variance_config,
    dimensions,
    started_at,
  };
}

function bootstrapExposure(payload: unknown): Record<string, unknown> {
  if (!Array.isArray(payload) || payload.length !== 8) {
    throw new ResultsInputError("analysis_run_bootstrap returned a malformed Exposure payload");
  }
  const [
    app_id,
    environment_id,
    id_type,
    run_id,
    targeting_key_hash,
    variant,
    first_exposure_ts,
    window_anchor,
  ] = payload;
  return {
    app_id,
    environment_id,
    id_type,
    run_id,
    targeting_key_hash,
    variant,
    first_exposure_ts,
    window_anchor,
  };
}

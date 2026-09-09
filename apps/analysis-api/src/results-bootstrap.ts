import type { PipeParams, TinybirdReadTransport } from "./tinybird";

const RUN_INPUTS_PIPE = "analysis_run_inputs";
const EXPOSURES_PIPE = "analysis_deduped_exposures";

export async function readResultsRunRows(
  tinybird: TinybirdReadTransport,
  params: PipeParams,
): Promise<readonly unknown[]> {
  // Read the Run first so its selected Copy Pipe watermark can bound every
  // later query. The former combined bootstrap could not pass a watermark it
  // had only just discovered into its own Exposure subquery.
  return tinybird.readPipe(RUN_INPUTS_PIPE, params);
}

export function readResultsExposureRows(
  tinybird: TinybirdReadTransport,
  params: PipeParams,
): Promise<readonly unknown[]> {
  return tinybird.readPipe(EXPOSURES_PIPE, params);
}

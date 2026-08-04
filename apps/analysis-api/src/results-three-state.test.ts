import { AnalysisResultsEnvelopeSchema, type ErrorResponse } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import {
  makeResultsApp,
  makeResultsHarness,
  RESULTS_PATH,
  resultsAuthInit,
} from "./results-test-harness";
import { RUN_ID, rowsByPipe } from "./results-test-support";
import { type PipeParams, TinybirdReadError, type TinybirdReadTransport } from "./tinybird";

/**
 * Three observable states for Results reads (SPL-290 / SPL-302 / ADR-0036):
 * full inputs → ready StatsOutput envelope; incomplete locked inputs → 200
 * `no_data` naming the missing input (same discriminator as attention-rollup);
 * no Run snapshot → typed 404; Tinybird outage → SERVICE_UNAVAILABLE.
 */
describe("GET experiment results three-state distinction (SPL-290/SPL-302)", () => {
  it("returns 200 no_data naming Metric Events when Exposures exist but Metric pipes are empty", async () => {
    const { app, tinybird } = makeResultsHarness({
      ...rowsByPipe(),
      analysis_metric_values: [],
      analysis_pre_period_covariates: [],
    });

    const res = await app.request(`${RESULTS_PATH}?runId=${RUN_ID}`, resultsAuthInit("GET"));

    expect(res.status).toBe(200);
    const body = AnalysisResultsEnvelopeSchema.parse(await res.json());
    expect(body).toEqual({
      state: "no_data",
      run_id: RUN_ID,
      control_variant: "control",
      missing: "metric_events",
    });
    expect(tinybird.calls.map((call) => call.pipeName)).toEqual([
      "analysis_run_inputs",
      "analysis_deduped_exposures",
      "analysis_metric_values",
      "analysis_pre_period_covariates",
      "analysis_activation_rows",
    ]);
  });

  it("returns typed RUN_NOT_FOUND (not 503) when the Run has no analysis_run_inputs row", async () => {
    const { app } = makeResultsHarness({
      ...rowsByPipe(),
      analysis_run_inputs: [],
    });

    const res = await app.request(`${RESULTS_PATH}?runId=${RUN_ID}`, resultsAuthInit("GET"));

    expect(res.status).toBe(404);
    const body = (await res.json()) as ErrorResponse;
    expect(body.code).toBe("RUN_NOT_FOUND");
    expect(body.details).not.toHaveProperty("retryAfterMs");
  });

  it("maps a Tinybird upstream failure to SERVICE_UNAVAILABLE only", async () => {
    const tinybird: TinybirdReadTransport = {
      async readPipe(_pipeName: string, _params: PipeParams) {
        throw new TinybirdReadError("Tinybird pipe read failed with HTTP 404");
      },
    };

    const res = await makeResultsApp(tinybird).request(
      `${RESULTS_PATH}?runId=${RUN_ID}`,
      resultsAuthInit("GET"),
    );

    expect(res.status).toBe(503);
    const body = (await res.json()) as ErrorResponse;
    expect(body).toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      message: "analysis data is unavailable",
      details: { retryAfterMs: 30_000 },
    });
  });
});

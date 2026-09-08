import { AnalysisResultsEnvelopeSchema, type ErrorResponse } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { makeResultsHarness, RESULTS_PATH, resultsAuthInit } from "./results-test-harness";
import { DATA_WATERMARK, RUN_CONFIG_HASH, RUN_ID, rowsByPipe } from "./results-test-support";

describe("Experiment result evidence", () => {
  it("returns a deterministic token and recomputes through the exact submitted watermark", async () => {
    const current = makeResultsHarness();
    const currentResponse = await current.app.request(
      `${RESULTS_PATH}?runId=${RUN_ID}`,
      resultsAuthInit("GET"),
    );
    const currentEnvelope = AnalysisResultsEnvelopeSchema.parse(await currentResponse.json());
    expect(currentEnvelope).toMatchObject({
      state: "ready",
      data_watermark: DATA_WATERMARK,
      result_token: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    if (currentEnvelope.state !== "ready") throw new Error("expected ready result evidence");

    const recomputed = makeResultsHarness();
    const recomputedResponse = await recomputed.app.request(
      RESULTS_PATH,
      resultsAuthInit("POST", { runId: RUN_ID, dataWatermark: DATA_WATERMARK }),
    );
    const recomputedEnvelope = AnalysisResultsEnvelopeSchema.parse(await recomputedResponse.json());

    expect(recomputedResponse.status).toBe(200);
    expect(recomputedEnvelope).toMatchObject({
      state: "ready",
      data_watermark: DATA_WATERMARK,
      result_token: currentEnvelope.result_token,
      stats: currentEnvelope.stats,
    });
    expect(
      recomputed.tinybird.calls.every(
        (call) => call.params.ingest_watermark_ts === "2026-07-05 00:00:00.000",
      ),
    ).toBe(true);
  });

  it("fails loud instead of fabricating a token when the Run config hash is missing", async () => {
    const fixture = rowsByPipe();
    const [runInput] = fixture.analysis_run_inputs as Record<string, unknown>[];
    const { config_hash: _missing, ...withoutConfigHash } = runInput ?? {};
    fixture.analysis_run_inputs = [withoutConfigHash];
    const { app } = makeResultsHarness(fixture);

    const response = await app.request(`${RESULTS_PATH}?runId=${RUN_ID}`, resultsAuthInit("GET"));
    const error = (await response.json()) as ErrorResponse;

    expect(response.status).toBe(500);
    expect(error).toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      details: { fault: expect.stringContaining("config_hash") },
    });
    expect(JSON.stringify(error)).not.toContain(RUN_CONFIG_HASH);
  });
});

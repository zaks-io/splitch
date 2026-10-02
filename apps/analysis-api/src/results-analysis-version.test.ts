import {
  AnalysisResultsEnvelopeSchema,
  CURRENT_ANALYSIS_VERSION,
  canonicalHash,
  createResultToken,
  type ErrorResponse,
  resultTokenStats,
} from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { makeResultsHarness, RESULTS_PATH, resultsAuthInit } from "./results-test-harness";
import {
  APP_ID,
  DATA_WATERMARK,
  ENVIRONMENT_ID,
  EXPERIMENT_ID,
  RUN_CONFIG_HASH,
  RUN_ID,
  rowsByPipe,
} from "./results-test-support";

/**
 * The token this legacy fixture Run produced before analysis versioning existed,
 * at this fixed watermark on this fixed dataset. A legacy Run must keep it byte
 * for byte, or every pending Conclude prepared before the deploy goes stale.
 */
const LEGACY_FIXTURE_TOKEN =
  "sha256:b8a6af69eaef6679ed1ffa0c23669a29596e9e22c8f22bfb0db425dd6ebadf70";

async function readyEnvelope(rows = rowsByPipe()) {
  const { app } = makeResultsHarness(rows);
  const response = await app.request(
    RESULTS_PATH,
    resultsAuthInit("POST", { runId: RUN_ID, dataWatermark: DATA_WATERMARK }),
  );
  const envelope = AnalysisResultsEnvelopeSchema.parse(await response.json());
  if (envelope.state !== "ready") throw new Error("expected ready results");
  return envelope;
}

function withRunFields(fields: Record<string, unknown>) {
  const rows = rowsByPipe();
  const [run] = rows.analysis_run_inputs as Record<string, unknown>[];
  rows.analysis_run_inputs = [{ ...run, ...fields }];
  return rows;
}

const committedFields = {
  analysis_version: CURRENT_ANALYSIS_VERSION,
  target_n: 5000,
  target_n_source: "default",
  planned_duration_days: 7,
  planned_duration_override_reason: null,
};

describe("analysis version and Run commitments (ADR-0059)", () => {
  it("keeps a legacy Run's token byte-identical and labels its version", async () => {
    const envelope = await readyEnvelope();

    expect(envelope.result_token).toBe(LEGACY_FIXTURE_TOKEN);
    // The pre-versioning evidence identity, recomputed: no analysis version key,
    // and the estimand disclosure stripped exactly as every token strips it.
    expect(envelope.result_token).toBe(
      await canonicalHash({
        appId: APP_ID,
        environmentId: ENVIRONMENT_ID,
        experimentId: EXPERIMENT_ID,
        runId: RUN_ID,
        runConfigHash: RUN_CONFIG_HASH,
        stats: resultTokenStats(envelope.stats),
      }),
    );
    expect(envelope.run_commitments).toEqual({
      analysis_version_source: "legacy",
      analysis_version: "legacy-unversioned",
      target_n: null,
      target_n_source: null,
      planned_duration_days: null,
      planned_duration_override_reason: null,
    });
  });

  it("binds a versioned Run's token to the version it froze", async () => {
    const legacy = await readyEnvelope();
    const versioned = await readyEnvelope(withRunFields(committedFields));

    expect(versioned.stats).toEqual(legacy.stats);
    expect(versioned.result_token).not.toBe(legacy.result_token);
    expect(versioned.result_token).toBe(
      await createResultToken({
        appId: APP_ID,
        environmentId: ENVIRONMENT_ID,
        experimentId: EXPERIMENT_ID,
        runId: RUN_ID,
        runConfigHash: RUN_CONFIG_HASH,
        analysisVersion: CURRENT_ANALYSIS_VERSION,
        stats: versioned.stats,
      }),
    );
    expect(versioned.run_commitments).toEqual({
      analysis_version_source: "frozen",
      ...committedFields,
    });
  });

  it("reports a caller target and a labeled duration override", async () => {
    const envelope = await readyEnvelope(
      withRunFields({
        ...committedFields,
        target_n: 12_000,
        target_n_source: "caller",
        planned_duration_days: 10,
        planned_duration_override_reason: "holiday code freeze",
      }),
    );

    expect(envelope.run_commitments).toMatchObject({
      target_n: 12_000,
      target_n_source: "caller",
      planned_duration_days: 10,
      planned_duration_override_reason: "holiday code freeze",
    });
  });

  it("refuses a Run frozen under a version this deployment does not implement", async () => {
    const { app } = makeResultsHarness(
      withRunFields({ ...committedFields, analysis_version: "2099-01-01" }),
    );

    const response = await app.request(`${RESULTS_PATH}?runId=${RUN_ID}`, resultsAuthInit("GET"));
    const error = (await response.json()) as ErrorResponse;

    expect(response.status).toBe(400);
    expect(JSON.stringify(error)).toContain("2099-01-01");
  });

  it("refuses a pinned watermark later than the ingested evidence", async () => {
    const { app } = makeResultsHarness();

    const response = await app.request(
      RESULTS_PATH,
      resultsAuthInit("POST", { runId: RUN_ID, dataWatermark: "2026-07-12T00:00:00.000Z" }),
    );

    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toContain(
      "later than the ingested evidence watermark",
    );
  });

  it("refuses a Run input that omits a commitment column instead of reading it as legacy", async () => {
    const rows = rowsByPipe();
    const [run] = rows.analysis_run_inputs as Record<string, unknown>[];
    const { analysis_version: _omitted, ...withoutVersion } = run ?? {};
    rows.analysis_run_inputs = [withoutVersion];
    const { app } = makeResultsHarness(rows);

    const response = await app.request(`${RESULTS_PATH}?runId=${RUN_ID}`, resultsAuthInit("GET"));

    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toContain("omitted analysis_version");
  });

  it("refuses a versioned Run that recorded no planned duration", async () => {
    const { app } = makeResultsHarness(
      withRunFields({ ...committedFields, planned_duration_days: null }),
    );

    const response = await app.request(`${RESULTS_PATH}?runId=${RUN_ID}`, resultsAuthInit("GET"));

    expect(response.status).toBe(400);
  });
});

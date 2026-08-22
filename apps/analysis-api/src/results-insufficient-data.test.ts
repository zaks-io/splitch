import { createServer, type Server } from "node:http";
import { AnalysisResultsEnvelopeSchema, type ErrorResponse } from "@splitch/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { AnalysisApiEnv } from "./env";
import {
  makeResultsApp,
  makeResultsHarness,
  RESULTS_PATH,
  resultsAuthInit,
} from "./results-test-harness";
import { type RowsByPipe, RUN_ID, rowsByPipe } from "./results-test-support";
import { createTinybirdReadTransport } from "./tinybird";

/**
 * SPL-302: opaque `analysis failed` must not be the terminal state. A Run with
 * Exposures but no Metric Events is 200 `no_data` (attention-rollup parity);
 * a full input set returns `ready`. Production Run Snapshots still carry D1
 * MetricRef[] in decision_family — that shape must not 500 either.
 */
describe("GET experiment results insufficient-data typing (SPL-302)", () => {
  it("returns 200 no_data naming Metric Events when Exposures exist but Metric pipes are empty", async () => {
    const { app } = makeResultsHarness({
      ...rowsByPipe(),
      analysis_metric_values: [],
      analysis_pre_period_covariates: [],
    });

    const res = await app.request(`${RESULTS_PATH}?runId=${RUN_ID}`, resultsAuthInit("GET"));

    expect(res.status).toBe(200);
    expect(AnalysisResultsEnvelopeSchema.parse(await res.json())).toEqual({
      state: "no_data",
      run_id: RUN_ID,
      control_variant: "control",
      missing: "metric_events",
    });
  });

  it("returns 200 no_data before querying Metric pipes when the Run has no Exposures", async () => {
    const { app, tinybird } = makeResultsHarness({
      ...rowsByPipe(),
      analysis_deduped_exposures: [],
    });

    const res = await app.request(`${RESULTS_PATH}?runId=${RUN_ID}`, resultsAuthInit("GET"));

    expect(res.status).toBe(200);
    expect(AnalysisResultsEnvelopeSchema.parse(await res.json())).toEqual({
      state: "no_data",
      run_id: RUN_ID,
      control_variant: "control",
      missing: "exposures",
    });
    expect(tinybird.calls.map((call) => call.pipeName)).toEqual([
      "analysis_run_inputs",
      "analysis_deduped_exposures",
    ]);
  });

  it("returns Exposure health without querying per-Metric pipes for a Run with no Metrics", async () => {
    const rows = rowsByPipe();
    const [runInput] = rows.analysis_run_inputs as Record<string, unknown>[];
    const { app, tinybird } = makeResultsHarness({
      ...rows,
      analysis_run_inputs: [
        {
          ...runInput,
          decision_family: JSON.stringify([]),
          guardrail_decisions: JSON.stringify([]),
        },
      ],
      analysis_metric_values: [],
      analysis_pre_period_covariates: [],
    });

    const res = await app.request(`${RESULTS_PATH}?runId=${RUN_ID}`, resultsAuthInit("GET"));

    expect(res.status).toBe(200);
    expect(AnalysisResultsEnvelopeSchema.parse(await res.json())).toMatchObject({
      state: "ready",
      run_id: RUN_ID,
      control_variant: "control",
      stats: { health: { deduped_counts: { control: 2, treatment: 2 } } },
    });
    expect(tinybird.calls.map((call) => call.pipeName)).toEqual([
      "analysis_run_inputs",
      "analysis_deduped_exposures",
      "analysis_activation_rows",
    ]);
  });
});

describe("GET experiment results production-shaped Run inputs", () => {
  it("expands production MetricRef decision_family and returns ready when Metric rows exist", async () => {
    const { app } = makeResultsHarness(productionShapedRows());

    const res = await app.request(`${RESULTS_PATH}?runId=${RUN_ID}`, resultsAuthInit("GET"));

    expect(res.status).toBe(200);
    const envelope = AnalysisResultsEnvelopeSchema.parse(await res.json());
    expect(envelope.state).toBe("ready");
    if (envelope.state !== "ready") throw new Error("expected ready");
    expect(envelope.run_id).toBe(RUN_ID);
    expect(envelope.stats.arm_results.length).toBeGreaterThan(0);
  });

  it("names Metric Events for MetricRef-shaped snapshots with Exposures but no Metric rows", async () => {
    const { app } = makeResultsHarness({
      ...productionShapedRows(),
      analysis_metric_values: [],
    });

    const res = await app.request(`${RESULTS_PATH}?runId=${RUN_ID}`, resultsAuthInit("GET"));

    expect(res.status).toBe(200);
    const envelope = AnalysisResultsEnvelopeSchema.parse(await res.json());
    expect(envelope).toMatchObject({ state: "no_data", missing: "metric_events" });
  });

  it("expands one MetricRef across every non-Control Variant and returns arm_results for each", async () => {
    const { app } = makeResultsHarness(multiTreatmentRows());

    const res = await app.request(`${RESULTS_PATH}?runId=${RUN_ID}`, resultsAuthInit("GET"));

    expect(res.status).toBe(200);
    const envelope = AnalysisResultsEnvelopeSchema.parse(await res.json());
    expect(envelope.state).toBe("ready");
    if (envelope.state !== "ready") throw new Error("expected ready");
    const members = envelope.stats.arm_results
      .filter((arm) => arm.in_bh_family)
      .map((arm) => `${arm.metric_id}/${arm.variant}`)
      .sort();
    expect(members).toEqual(["conversion/treatment_a", "conversion/treatment_b"]);
  });

  it("refuses MetricRef guardrail_decisions instead of analysing an unbounded Run", async () => {
    // A MetricRef carries no downside_threshold_pct, so a Run frozen before Start
    // resolved thresholds has nothing to check against. Reading it as "no
    // guardrails declared" would pass every guardrail silently.
    const rows = rowsByPipe();
    const [runInput] = rows.analysis_run_inputs as Record<string, unknown>[];
    const { app } = makeResultsHarness({
      ...rows,
      analysis_run_inputs: [
        {
          ...runInput,
          guardrail_decisions: JSON.stringify([{ metricId: "guardrail_conversion" }]),
        },
      ],
    });

    const res = await app.request(`${RESULTS_PATH}?runId=${RUN_ID}`, resultsAuthInit("GET"));

    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorResponse;
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(JSON.stringify(body.details)).toContain("re-Started");
  });

  it("puts a named fault on INTERNAL_SERVER_ERROR rather than empty details", async () => {
    const rows = rowsByPipe();
    const [runInput] = rows.analysis_run_inputs as { run_id: string }[];
    const { app } = makeResultsHarness({
      ...rows,
      analysis_run_inputs: [{ ...runInput, run_id: "run_some_other_run" }],
    });

    const res = await app.request(`${RESULTS_PATH}?runId=${RUN_ID}`, resultsAuthInit("GET"));

    expect(res.status).toBe(500);
    const body = (await res.json()) as ErrorResponse;
    expect(body.code).toBe("INTERNAL_SERVER_ERROR");
    expect(body.details).toEqual({
      fault:
        "analysis_run_inputs returned Run run_some_other_run for requested Run run_checkout_banner_1",
    });
  });
});

describe("GET experiment results real Tinybird transport path (SPL-302)", () => {
  let server: Server | undefined;
  let baseUrl: string | undefined;

  afterEach(async () => {
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => (error ? reject(error) : resolve()));
    });
    server = undefined;
    baseUrl = undefined;
  });

  it("materializes fixture pipe JSON through createTinybirdReadTransport into a ready envelope", async () => {
    const fixture = productionShapedRows();
    ({ server, baseUrl } = await listenPipeServer(fixture));
    const tinybird = createTinybirdReadTransport(pipeEnv(baseUrl));

    const res = await makeResultsApp(tinybird).request(
      `${RESULTS_PATH}?runId=${RUN_ID}`,
      resultsAuthInit("GET"),
    );

    expect(res.status).toBe(200);
    const envelope = AnalysisResultsEnvelopeSchema.parse(await res.json());
    expect(envelope.state).toBe("ready");
    if (envelope.state !== "ready") throw new Error("expected ready");
    expect(envelope.run_id).toBe(RUN_ID);
    expect(envelope.control_variant).toBe("control");
    expect(envelope.stats.health.deduped_counts).toEqual({ control: 2, treatment: 2 });
  });

  it("names Metric Events through the real transport when the Metric pipe returns []", async () => {
    const fixture = { ...productionShapedRows(), analysis_metric_values: [] };
    ({ server, baseUrl } = await listenPipeServer(fixture));
    const tinybird = createTinybirdReadTransport(pipeEnv(baseUrl));

    const res = await makeResultsApp(tinybird).request(
      `${RESULTS_PATH}?runId=${RUN_ID}`,
      resultsAuthInit("GET"),
    );

    expect(res.status).toBe(200);
    expect(AnalysisResultsEnvelopeSchema.parse(await res.json())).toMatchObject({
      state: "no_data",
      missing: "metric_events",
    });
  });
});

/** The D1 MetricRef decision_family production snapshots still carry today. */
function productionShapedRows(): RowsByPipe {
  const rows = rowsByPipe();
  const [runInput] = rows.analysis_run_inputs as Record<string, unknown>[];
  return {
    ...rows,
    analysis_run_inputs: [
      {
        ...runInput,
        decision_family: JSON.stringify([{ metricId: "conversion" }]),
        guardrail_decisions: JSON.stringify([]),
      },
    ],
  };
}

/**
 * Two treatment Variants: MetricRef expansion fans out to every non-Control
 * arm. arm_results must cover each expanded (metric, variant) pair or FDR
 * throws at applyDecisionFamilyCorrection.
 */
function multiTreatmentRows(): RowsByPipe {
  const rows = rowsByPipe();
  const [runInput] = rows.analysis_run_inputs as Record<string, unknown>[];
  return {
    ...rows,
    analysis_run_inputs: [
      {
        ...runInput,
        allocation: JSON.stringify({ control: 34, treatment_a: 33, treatment_b: 33 }),
        decision_family: JSON.stringify([{ metricId: "conversion" }]),
        guardrail_decisions: JSON.stringify([]),
      },
    ],
    analysis_deduped_exposures: [
      exposure("control", "control_0"),
      exposure("control", "control_1"),
      exposure("treatment_a", "treatment_a_0"),
      exposure("treatment_a", "treatment_a_1"),
      exposure("treatment_b", "treatment_b_0"),
      exposure("treatment_b", "treatment_b_1"),
    ],
    analysis_metric_values: [
      metricValue("control_0", 1),
      metricValue("control_1", 0),
      metricValue("treatment_a_0", 1),
      metricValue("treatment_a_1", 1),
      metricValue("treatment_b_0", 0),
      metricValue("treatment_b_1", 1),
    ],
  };
}

function exposure(variant: string, targetingKeyHash: string) {
  return {
    app_id: "app_checkout",
    environment_id: "env_prod",
    id_type: "user",
    targeting_key_hash: targetingKeyHash,
    run_id: RUN_ID,
    variant,
    first_exposure_ts: "2026-07-01T00:00:00.000Z",
    window_anchor: "2026-07-01T00:00:00.000Z",
  };
}

function metricValue(targetingKeyHash: string, value: number) {
  return {
    targeting_key_hash: targetingKeyHash,
    run_id: RUN_ID,
    metric_id: "conversion",
    metric_type: "binomial",
    value,
    in_window: 1,
  };
}

function listenPipeServer(rows: RowsByPipe): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.headers.authorization !== "Bearer test-read-token") {
        response.writeHead(401).end();
        return;
      }
      const pipeName = url.pathname.match(/^\/v0\/pipes\/([^/]+)\.json$/)?.[1];
      if (!pipeName) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: rows[pipeName] ?? [] }));
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("pipe fixture server has no address"));
        return;
      }
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

function pipeEnv(apiUrl: string): AnalysisApiEnv {
  return {
    TINYBIRD_API_URL: apiUrl,
    TINYBIRD_READ_TOKEN: "test-read-token",
  } as AnalysisApiEnv;
}

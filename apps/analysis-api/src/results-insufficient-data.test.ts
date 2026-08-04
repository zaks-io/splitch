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
 * Exposures but no Metric Events names Metric Events; a full input set returns
 * a result. Production Run Snapshots still carry D1 MetricRef[] in
 * decision_family — that shape must not 500 either.
 */
describe("GET experiment results insufficient-data typing (SPL-302)", () => {
  it("returns VALIDATION_ERROR naming Metric Events when Exposures exist but Metric pipes are empty", async () => {
    const { app } = makeResultsHarness({
      ...rowsByPipe(),
      analysis_metric_values: [],
      analysis_pre_period_covariates: [],
    });

    const res = await app.request(`${RESULTS_PATH}?runId=${RUN_ID}`, resultsAuthInit("GET"));

    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorResponse;
    expect(body).toMatchObject({
      code: "VALIDATION_ERROR",
      message: "no Metric Events for this Run",
      details: {
        issues: [{ path: ["metric_events"], message: "no Metric Events for this Run" }],
      },
    });
  });

  it("returns VALIDATION_ERROR naming Exposures when the Run has no Exposure rows", async () => {
    const { app } = makeResultsHarness({
      ...rowsByPipe(),
      analysis_deduped_exposures: [],
    });

    const res = await app.request(`${RESULTS_PATH}?runId=${RUN_ID}`, resultsAuthInit("GET"));

    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorResponse;
    expect(body).toMatchObject({
      code: "VALIDATION_ERROR",
      message: "no Exposures for this Run",
      details: {
        issues: [{ path: ["exposures"], message: "no Exposures for this Run" }],
      },
    });
  });

  it("expands production MetricRef decision_family and returns a result when Metric rows exist", async () => {
    const { app } = makeResultsHarness(productionShapedRows());

    const res = await app.request(`${RESULTS_PATH}?runId=${RUN_ID}`, resultsAuthInit("GET"));

    expect(res.status).toBe(200);
    const envelope = AnalysisResultsEnvelopeSchema.parse(await res.json());
    expect(envelope.run_id).toBe(RUN_ID);
    expect(envelope.stats.arm_results.length).toBeGreaterThan(0);
  });

  it("names Metric Events for MetricRef-shaped snapshots with Exposures but no Metric rows", async () => {
    const { app } = makeResultsHarness({
      ...productionShapedRows(),
      analysis_metric_values: [],
    });

    const res = await app.request(`${RESULTS_PATH}?runId=${RUN_ID}`, resultsAuthInit("GET"));

    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorResponse;
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(body.details).toMatchObject({
      issues: [{ path: ["metric_events"] }],
    });
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

  it("materializes fixture pipe JSON through createTinybirdReadTransport into a StatsOutput", async () => {
    const fixture = productionShapedRows();
    ({ server, baseUrl } = await listenPipeServer(fixture));
    const tinybird = createTinybirdReadTransport(pipeEnv(baseUrl));

    const res = await makeResultsApp(tinybird).request(
      `${RESULTS_PATH}?runId=${RUN_ID}`,
      resultsAuthInit("GET"),
    );

    expect(res.status).toBe(200);
    const envelope = AnalysisResultsEnvelopeSchema.parse(await res.json());
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

    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorResponse;
    expect(body).toMatchObject({
      code: "VALIDATION_ERROR",
      details: { issues: [{ path: ["metric_events"] }] },
    });
  });
});

/** The D1 MetricRef shape production snapshots still carry today. */
function productionShapedRows(): RowsByPipe {
  const rows = rowsByPipe();
  const [runInput] = rows.analysis_run_inputs as Record<string, unknown>[];
  return {
    ...rows,
    analysis_run_inputs: [
      {
        ...runInput,
        decision_family: JSON.stringify([{ metricId: "conversion" }]),
        guardrail_decisions: JSON.stringify([{ metricId: "guardrail_conversion" }]),
      },
    ],
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

import { ExperimentResultsResponseSchema } from "@splitch/contracts";
import { parsePanelExperimentResultsOutput } from "@splitch/control-plane-sdk/panel-experiments";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app";
import {
  AnalysisResultsUnavailableError,
  createAnalysisResultsReader,
} from "./attention-analysis-reader";
import { binding, deps, RESULTS_PATH } from "./delegated-routes-test-fixtures";
import { LATEST_RUN_ID, results } from "./panel-experiment-results-test-harness";
import { analysisEnvelope, statsOutput } from "./panel-experiments-test-fixtures";

const SCOPE = {
  appId: "app_1",
  environmentId: "env_1",
  experimentId: "exp_1",
  runId: "run_7",
};

function additiveEnvelope(runId: string) {
  const stats = statsOutput();
  return {
    ...analysisEnvelope(runId, stats),
    future_analysis_field: { revision: 2 },
    stats: {
      ...stats,
      arm_results: stats.arm_results.map((arm) => ({ ...arm, future_arm_field: 42 })),
    },
  };
}

async function publicResults(envelope: unknown) {
  const analysis = binding([], Response.json(envelope));
  return createApp(deps({ bindings: { "analysis-api": analysis } })).request(RESULTS_PATH, {
    headers: { authorization: "Bearer stub" },
  });
}

describe("Analysis additive fields across the Control Plane deploy window", () => {
  it("serves public Results with strict output after stripping envelope and arm additions", async () => {
    const response = await publicResults(additiveEnvelope(SCOPE.runId));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(ExperimentResultsResponseSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({ state: "ready", stats: statsOutput() });
    expect(body).not.toHaveProperty("future_analysis_field");
    expect(body.stats.arm_results[0]).not.toHaveProperty("future_arm_field");
    expect(
      ExperimentResultsResponseSchema.safeParse({ ...body, future_analysis_field: 1 }).success,
    ).toBe(false);
    expect(
      ExperimentResultsResponseSchema.safeParse({
        ...body,
        stats: additiveEnvelope(SCOPE.runId).stats,
      }).success,
    ).toBe(false);
  });

  it("serves panel Results with the same strict stats after stripping additive fields", async () => {
    const response = await results(
      vi.fn(async () => Response.json(additiveEnvelope(LATEST_RUN_ID))),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(parsePanelExperimentResultsOutput(body).success).toBe(true);
    expect(body).toMatchObject({ state: "ready", stats: statsOutput() });
    expect(body).not.toHaveProperty("future_analysis_field");
    expect(body.stats.arm_results[0]).not.toHaveProperty("future_arm_field");
  });

  it("unwraps attention Results with unchanged stats after stripping additive fields", async () => {
    const reader = createAnalysisResultsReader({
      fetch: async () => Response.json(additiveEnvelope(SCOPE.runId)),
    });

    await expect(reader.read(SCOPE, "user_1")).resolves.toEqual(statsOutput());
  });

  it("still rejects unknown inbound Results request fields before calling Analysis", async () => {
    const forwarded: Request[] = [];
    const analysis = binding(forwarded, Response.json(additiveEnvelope(SCOPE.runId)));
    const response = await createApp(deps({ bindings: { "analysis-api": analysis } })).request(
      RESULTS_PATH,
      {
        method: "POST",
        headers: { authorization: "Bearer stub", "content-type": "application/json" },
        body: JSON.stringify({ runId: SCOPE.runId, future_analysis_field: 1 }),
      },
    );

    expect(response.status).toBe(400);
    expect(forwarded).toHaveLength(0);
  });

  it.each([
    ["missing Run id", "run_id", undefined],
    ["mistyped Run id", "run_id", 42],
    ["missing arm estimate", "point_estimate", undefined],
    ["mistyped arm estimate", "point_estimate", "0.8"],
  ])("fails loud on %s even with additive fields", async (_label, field, value) => {
    function malformed(runId: string) {
      const envelope = additiveEnvelope(runId);
      return field === "run_id"
        ? { ...envelope, run_id: value }
        : {
            ...envelope,
            stats: {
              ...envelope.stats,
              arm_results: envelope.stats.arm_results.map((arm) => ({ ...arm, [field]: value })),
            },
          };
    }

    const response = await publicResults(malformed(SCOPE.runId));
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    await expect(
      results(vi.fn(async () => Response.json(malformed(LATEST_RUN_ID)))),
    ).rejects.toThrow();
    const reader = createAnalysisResultsReader({
      fetch: async () => Response.json(malformed(SCOPE.runId)),
    });
    await expect(reader.read(SCOPE, "user_1")).rejects.toBeInstanceOf(
      AnalysisResultsUnavailableError,
    );
  });
});

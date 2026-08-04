import { describe, expect, it } from "vitest";
import {
  AnalysisResultsUnavailableError,
  createAnalysisResultsReader,
} from "./attention-analysis-reader";
import { ExperimentIntegrityError } from "./attention-rollup-errors";
import { statsOutput } from "./attention-rollup-fixture";

const SCOPE = {
  appId: "app_checkout",
  environmentId: "env_prod",
  experimentId: "exp_1",
  runId: "run_1",
};

function analysisEnvelope(stats = statsOutput()) {
  return {
    run_id: SCOPE.runId,
    control_variant: "control",
    stats,
  };
}

describe("createAnalysisResultsReader timeout", () => {
  // A hung service binding must not stall the read forever: with
  // ANALYSIS_READ_CONCURRENCY capped at 8 and up to 200 planned reads, one
  // non-responding fetch would otherwise occupy a concurrency slot for the
  // platform's full subrequest duration. A tiny injected timeout proves the
  // bound is real without slowing the suite down.
  it("aborts a non-responding fetch after the configured timeout", async () => {
    const reader = createAnalysisResultsReader(
      {
        fetch: (request) =>
          new Promise((_, reject) =>
            request.signal.addEventListener("abort", () => reject(request.signal.reason)),
          ),
      },
      5,
    );

    await expect(reader.read(SCOPE, "actor_1")).rejects.toBeInstanceOf(
      AnalysisResultsUnavailableError,
    );
  });

  it("passes an already-aborting signal on the outgoing request", async () => {
    let sawSignal: AbortSignal | undefined;
    const reader = createAnalysisResultsReader(
      {
        fetch: async (request) => {
          sawSignal = request.signal;
          return new Response(JSON.stringify({}), { status: 404 });
        },
      },
      10_000,
    );

    await reader.read(SCOPE, "actor_1").catch(() => undefined);
    expect(sawSignal).toBeInstanceOf(AbortSignal);
    expect(sawSignal?.aborted).toBe(false);
  });
});

describe("createAnalysisResultsReader three-state envelope unwrap", () => {
  // The Analysis Worker returns AnalysisResultsEnvelope. Parsing that body as
  // bare StatsOutput fails Zod and was reported as SERVICE_UNAVAILABLE even
  // when Tinybird and StatsEngine succeeded (SPL-290).
  it("unwraps a successful AnalysisResultsEnvelope to StatsOutput", async () => {
    const reader = createAnalysisResultsReader({
      fetch: async () => Response.json(analysisEnvelope(statsOutput({ srm: true }))),
    });

    await expect(reader.read(SCOPE, "actor_1")).resolves.toMatchObject({
      srm: { srm_is_mismatch: true },
    });
  });

  it("maps typed RUN_NOT_FOUND to null (no_data), not SERVICE_UNAVAILABLE", async () => {
    const reader = createAnalysisResultsReader({
      fetch: async () =>
        Response.json(
          { code: "RUN_NOT_FOUND", message: "Experiment Run not found", details: {} },
          { status: 404 },
        ),
    });

    await expect(reader.read(SCOPE, "actor_1")).resolves.toBeNull();
  });

  it("keeps upstream SERVICE_UNAVAILABLE as AnalysisResultsUnavailableError", async () => {
    const reader = createAnalysisResultsReader({
      fetch: async () =>
        Response.json(
          {
            code: "SERVICE_UNAVAILABLE",
            message: "analysis data is unavailable",
            details: { retryAfterMs: 30_000 },
          },
          { status: 503 },
        ),
    });

    await expect(reader.read(SCOPE, "actor_1")).rejects.toBeInstanceOf(
      AnalysisResultsUnavailableError,
    );
  });

  it("refuses a provenance-mismatched envelope as a permanent integrity fault", async () => {
    const reader = createAnalysisResultsReader({
      fetch: async () =>
        Response.json({
          ...analysisEnvelope(),
          run_id: "run_other",
        }),
    });

    // Must not be AnalysisResultsUnavailableError: that class maps to retryable
    // SERVICE_UNAVAILABLE on the rollup, and polling cannot clear a mislabelled Run.
    await expect(reader.read(SCOPE, "actor_1")).rejects.toSatisfy(
      (cause: unknown) =>
        cause instanceof ExperimentIntegrityError &&
        !(cause instanceof AnalysisResultsUnavailableError) &&
        cause.message.includes("not Run run_1"),
    );
  });
});

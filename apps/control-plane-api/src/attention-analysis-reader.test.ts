import { describe, expect, it } from "vitest";
import {
  AnalysisResultsUnavailableError,
  createAnalysisResultsReader,
} from "./attention-analysis-reader";

const SCOPE = {
  appId: "app_checkout",
  environmentId: "env_prod",
  experimentId: "exp_1",
  runId: "run_1",
};

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

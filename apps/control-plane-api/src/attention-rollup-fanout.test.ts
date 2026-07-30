import { describe, expect, it, vi } from "vitest";
import type { AnalysisResultsReader } from "./attention-analysis-reader";
import {
  ANALYSIS_READ_CONCURRENCY,
  ANALYSIS_READ_LIMIT,
  ENVIRONMENT_FANOUT_LIMIT,
} from "./attention-rollup";
import {
  ATTENTION_TEST_TIMEOUT,
  authFor,
  harness,
  QA_ENVIRONMENT_ID,
  repository,
  setupAttentionRollupFixture,
  spyOnPlanningReads,
  statsOutput,
  USER_ID,
} from "./attention-rollup-fixture";
import {
  seedEnvironments,
  seedRunningExperiments,
  seedRunningExperimentWithoutRun,
} from "./attention-rollup-seeds";
import { ids } from "./config-store-fixture-data";

setupAttentionRollupFixture();

describe("attention rollup Analysis fan-out bounds", { timeout: ATTENTION_TEST_TIMEOUT }, () => {
  // Both budgets are pinned to literals here, not derived from the imported
  // constants: setup and expectation computed from the same constant move
  // together, so raising production to 201 would leave the pair green.
  it("pins both fan-out budgets to their documented values", () => {
    expect(ANALYSIS_READ_LIMIT).toBe(200);
    expect(ENVIRONMENT_FANOUT_LIMIT).toBe(200);
  });

  // Exercised at the exact boundary. `> LIMIT` and `>= LIMIT` disagree only on
  // the limit itself, so testing 202-vs-refused would pass for either.
  it("allows a rollup of exactly 200 Analysis reads", async () => {
    const repo = repository();
    // Two running Experiments already exist (dev + prod), so seed 198.
    await seedRunningExperiments(repo, QA_ENVIRONMENT_ID, 198);
    const read = vi.fn<AnalysisResultsReader["read"]>().mockResolvedValue(statsOutput());
    const app = harness({ read }, authFor(ids.appId, USER_ID));

    const response = await app.request(`/apps/${ids.appId}/attention-rollup`, {
      headers: { authorization: "Bearer valid" },
    });

    expect(response.status).toBe(200);
    expect(read).toHaveBeenCalledTimes(200);
  });

  it("refuses the 201st Analysis read instead of truncating", async () => {
    const repo = repository();
    await seedRunningExperiments(repo, QA_ENVIRONMENT_ID, 199);
    const read = vi.fn<AnalysisResultsReader["read"]>();
    const app = harness({ read }, authFor(ids.appId, USER_ID));

    const response = await app.request(`/apps/${ids.appId}/attention-rollup`, {
      headers: { authorization: "Bearer valid" },
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "ATTENTION_FANOUT_LIMIT_EXCEEDED",
      details: {
        appId: ids.appId,
        limit: 200,
        runningExperiments: 201,
        recommendedAction: "READ_PER_ENVIRONMENT",
      },
    });
    expect(read).not.toHaveBeenCalled();
  });

  // The materializing per-Environment read is itself bounded (to
  // `ANALYSIS_READ_LIMIT + 1` rows), so once an Environment holds more running
  // Experiments than that bound, `reads.length` for that Environment is a
  // floor, not a total. The reported `runningExperiments` must still be the
  // true count: 210 seeded in QA plus the 2 the fixture seeds elsewhere, not
  // 201 (the bounded read's own cap) plus 2.
  it("reports the true running-Experiment count, never the bounded read's page size", async () => {
    const repo = repository();
    await seedRunningExperiments(repo, QA_ENVIRONMENT_ID, 210);
    const read = vi.fn<AnalysisResultsReader["read"]>();
    const app = harness({ read }, authFor(ids.appId, USER_ID));

    const response = await app.request(`/apps/${ids.appId}/attention-rollup`, {
      headers: { authorization: "Bearer valid" },
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "ATTENTION_FANOUT_LIMIT_EXCEEDED",
      details: {
        appId: ids.appId,
        limit: 200,
        runningExperiments: 212,
        recommendedAction: "READ_PER_ENVIRONMENT",
      },
    });
    expect(read).not.toHaveBeenCalled();
  });

  it("refuses before planning when the Environment count alone is over budget", async () => {
    const repo = repository();
    // 200 bulk Environments on top of the three the fixture seeds: 203 > 200.
    await seedEnvironments(repo, 200);
    const read = vi.fn<AnalysisResultsReader["read"]>();
    const { spied, listRunningExperiments, listEnvironments } = spyOnPlanningReads(repo);
    const app = harness({ read }, authFor(ids.appId, USER_ID), spied);

    const response = await app.request(`/apps/${ids.appId}/attention-rollup`, {
      headers: { authorization: "Bearer valid" },
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "ATTENTION_FANOUT_LIMIT_EXCEEDED",
      details: {
        appId: ids.appId,
        limit: 200,
        // The true count, from the COUNT probe. A bounded read alone can only
        // see 201, and reporting that in an error explaining the refusal would
        // be a fabricated number.
        environments: 203,
        // Planning never ran, so there is no honest running-Experiment count.
        runningExperiments: null,
        recommendedAction: "READ_PER_ENVIRONMENT",
      },
    });
    expect(read).not.toHaveBeenCalled();
    // The read that enforces the budget must itself be bounded: one row past the
    // budget decides it, and materializing all 203 is the work being refused.
    const rows = await listEnvironments.mock.results[0]?.value;
    expect(rows).toHaveLength(201);
    // The point of this budget is that it fires BEFORE the per-Environment D1
    // fan-out it exists to prevent; observing Analysis reads alone cannot tell
    // the difference between refusing early and refusing after 203 D1 reads.
    expect(listRunningExperiments).not.toHaveBeenCalled();
  });

  // A `running` Experiment with no liveRunId is a corrupt row of ours. Rendering
  // it as a retryable SERVICE_UNAVAILABLE would tell a polling agent to wait out
  // a fault that waiting never repairs.
  it("refuses a running Experiment with no live Run as a non-retryable fault", async () => {
    const repo = repository();
    const experimentId = await seedRunningExperimentWithoutRun(repo, QA_ENVIRONMENT_ID);
    const read = vi.fn<AnalysisResultsReader["read"]>().mockResolvedValue(statsOutput());
    const app = harness({ read }, authFor(ids.appId, USER_ID));

    const response = await app.request(`/apps/${ids.appId}/attention-rollup`, {
      headers: { authorization: "Bearer valid" },
    });
    const body = (await response.json()) as { code: string; message: string; details: unknown };

    expect(response.status).toBe(500);
    expect(body.code).toBe("INTERNAL_SERVER_ERROR");
    expect(body.message).toContain(experimentId);
    expect(body.details).not.toHaveProperty("retryAfterMs");
    expect(response.headers.get("retry-after")).toBeNull();
  });

  it("bounds how many Analysis reads are in flight at once", async () => {
    const repo = repository();
    await seedRunningExperiments(repo, QA_ENVIRONMENT_ID, 40);
    let inFlight = 0;
    let peak = 0;
    const analysisResults: AnalysisResultsReader = {
      async read() {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        return statsOutput();
      },
    };
    const app = harness(analysisResults, authFor(ids.appId, USER_ID));

    const response = await app.request(`/apps/${ids.appId}/attention-rollup`, {
      headers: { authorization: "Bearer valid" },
    });

    expect(response.status).toBe(200);
    // Pinned exactly, in both directions: asserting only
    // `peak <= ANALYSIS_READ_CONCURRENCY` passes vacuously for any raised
    // constant, and a pool that never fills would satisfy an upper bound alone.
    expect(ANALYSIS_READ_CONCURRENCY).toBe(8);
    expect(peak).toBe(ANALYSIS_READ_CONCURRENCY);
  });
});

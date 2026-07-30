import { envScope, type Repository } from "@splitch/db";
import { describe, expect, it, vi } from "vitest";
import type { AnalysisResultsReader } from "./attention-analysis-reader";
import {
  ATTENTION_TEST_TIMEOUT,
  repository,
  setupAttentionRollupFixture,
} from "./attention-rollup-fixture";
import { ids, NOW } from "./config-store-fixture-data";
import { OVERVIEW_ANALYSIS_READ_LIMIT } from "./overview-thresholds";
import { CALM, overview } from "./panel-overview-fixture";

/**
 * The Overview's Analysis read budget is enforced by a BOUNDED read, not by
 * counting rows an unbounded read has already paid for.
 */
setupAttentionRollupFixture();

/** The seeded graph already carries one running Experiment in this Environment. */
const SEEDED_RUNNING = 1;

/** Brings this Environment's running-Experiment count to exactly `total`. */
async function seedRunningTo(total: number): Promise<void> {
  const repo = repository();
  const scope = envScope(ids.appId, ids.environmentId);
  for (let index = 0; index < total - SEEDED_RUNNING; index += 1) {
    await repo.experiments.experiments.insert(scope, {
      id: `exp_bound_${String(index).padStart(3, "0")}`,
      appId: ids.appId,
      environmentId: ids.environmentId,
      key: `bound-${index}`,
      flagId: ids.flagId,
      name: `Bound ${index}`,
      status: "running",
      targetingKeyField: "userId",
      targetingKeyType: "user",
      metrics: "[]",
      guardrailMetrics: "[]",
      dimensions: "[]",
      liveRunId: ids.liveRunId,
      createdAt: NOW,
      updatedAt: NOW,
    });
  }
}

/** Watches the one read the budget governs, so the LIMIT it carries is visible. */
function spyOnRunningExperiments(repo: Repository) {
  const listRunningExperiments = vi.fn(
    repo.experiments.listRunningExperiments.bind(repo.experiments),
  );
  const spied: Repository = {
    ...repo,
    experiments: { ...repo.experiments, listRunningExperiments },
  };
  return { spied, listRunningExperiments };
}

/** Counts Analysis reads, which is one per running Experiment the budget admits. */
function countingReader(): { reader: AnalysisResultsReader; reads: () => number } {
  let reads = 0;
  return {
    reader: {
      async read() {
        reads += 1;
        return CALM;
      },
    },
    reads: () => reads,
  };
}

describe("panelOverviewRead running-Experiment read bound", () => {
  it(
    "never materializes more running Experiments than the budget allows",
    async () => {
      // Well past the budget, so an unbounded read returns a visibly larger page.
      await seedRunningTo(OVERVIEW_ANALYSIS_READ_LIMIT + 10);
      const { spied, listRunningExperiments } = spyOnRunningExperiments(repository());

      const response = await overview(countingReader().reader, { repo: spied });

      expect(response.status).toBe(200);
      // THE assertion of this file. The refusal alone cannot tell a bounded read
      // apart from an unbounded one refused after the fact; only the size of the
      // page the repository returned can. Exactly `+ 1`: the extra row is what
      // makes truncation OBSERVED rather than inferred.
      const rows = await listRunningExperiments.mock.results[0]?.value;
      expect(rows).toHaveLength(OVERVIEW_ANALYSIS_READ_LIMIT + 1);
    },
    ATTENTION_TEST_TIMEOUT,
  );

  it(
    "refuses the budget-blown Environment instead of classifying the page it read",
    async () => {
      await seedRunningTo(OVERVIEW_ANALYSIS_READ_LIMIT + 1);
      const counting = countingReader();

      const response = await overview(counting.reader);
      const overviewBody = (await response.json()) as { experiments: unknown };

      expect(overviewBody.experiments).toEqual({
        status: "unavailable",
        reason: "read_budget_exceeded",
        retryable: false,
      });
      // A truncated attention list renders as "nothing needs you", so the bounded
      // page is thrown away rather than classified.
      expect(counting.reads()).toBe(0);
    },
    ATTENTION_TEST_TIMEOUT,
  );

  it(
    "classifies a full budget of running Experiments without refusing it",
    async () => {
      // Exactly on the ceiling. `>` and `>=` disagree only here, so a case seeded
      // anywhere else passes for either predicate.
      await seedRunningTo(OVERVIEW_ANALYSIS_READ_LIMIT);
      const counting = countingReader();

      const response = await overview(counting.reader);
      const overviewBody = (await response.json()) as { experiments: { status: string } };

      expect(overviewBody.experiments.status).toBe("ok");
      // Every admitted Experiment was actually read, so the budget admitted the
      // whole page rather than a silently shortened one.
      expect(counting.reads()).toBe(OVERVIEW_ANALYSIS_READ_LIMIT);
    },
    ATTENTION_TEST_TIMEOUT,
  );
});

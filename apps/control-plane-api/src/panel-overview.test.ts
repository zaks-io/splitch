import { type AppOverviewResponse, AppOverviewResponseSchema } from "@splitch/contracts";
import { envScope } from "@splitch/db";
import { describe, expect, it } from "vitest";
import type { AnalysisResultsReader } from "./attention-analysis-reader";
import { AnalysisResultsUnavailableError } from "./attention-analysis-reader";
import {
  ATTENTION_TEST_TIMEOUT,
  DEV_EXPERIMENT_ID,
  OTHER_APP_ID,
  repository,
  setupAttentionRollupFixture,
  USER_ID,
} from "./attention-rollup-fixture";
import { ids, NOW } from "./config-store-fixture-data";
import { overviewStats } from "./overview-test-fixtures";
import { OVERVIEW_ANALYSIS_READ_LIMIT } from "./overview-thresholds";
import { panelOverviewRead } from "./panel-overview";

setupAttentionRollupFixture();

/** Every state gets its own counts, so a read of the wrong Run cannot pass. */
const SIGNIFICANT = overviewStats({
  deduped: { control: 4_011, treatment: 3_989 },
  significant: true,
});
const FAILING = overviewStats({
  deduped: { control: 7_100, treatment: 6_401 },
  srm: true,
  multipleRate: 0.037,
});
const CALM = overviewStats({ deduped: { control: 1_204, treatment: 1_198 } });

function readerFor(stats: Record<string, ReturnType<typeof overviewStats>>): AnalysisResultsReader {
  return {
    async read(scope) {
      return stats[scope.runId] ?? null;
    },
  };
}

const deadReader: AnalysisResultsReader = {
  async read() {
    throw new AnalysisResultsUnavailableError("analysis is down");
  },
};

async function overview(
  analysisResults: AnalysisResultsReader,
  input: { actorId?: string; appId?: string; environmentId?: string } = {},
): Promise<Response> {
  return panelOverviewRead(
    { repo: repository(), analysisResults, now: () => new Date(NOW) },
    {
      actorId: input.actorId ?? USER_ID,
      appId: input.appId ?? ids.appId,
      environmentId: input.environmentId ?? ids.environmentId,
    },
  );
}

async function body(response: Response): Promise<AppOverviewResponse> {
  return AppOverviewResponseSchema.parse(await response.json());
}

describe("panelOverviewRead attention", () => {
  it(
    "reports a Run that reached significance as needing a decision",
    async () => {
      const response = await overview(readerFor({ [ids.liveRunId]: SIGNIFICANT }));

      expect(response.status).toBe(200);
      const overviewBody = await body(response);
      expect(overviewBody.experiments).toEqual({
        status: "ok",
        needingDecision: [
          {
            id: ids.experimentId,
            name: "Checkout experiment",
            runId: ids.liveRunId,
            reasons: ["significance_reached"],
          },
        ],
        failing: [],
      });
    },
    ATTENTION_TEST_TIMEOUT,
  );

  it(
    "reports SRM and multiple-assignment quarantine together",
    async () => {
      const response = await overview(readerFor({ [ids.liveRunId]: FAILING }));

      const overviewBody = await body(response);
      expect(overviewBody.experiments).toMatchObject({
        status: "ok",
        failing: [
          {
            id: ids.experimentId,
            runId: ids.liveRunId,
            reasons: ["srm_firing", "multiple_assignment_quarantine"],
          },
        ],
      });
    },
    ATTENTION_TEST_TIMEOUT,
  );

  it(
    "renders a calm Environment as read-and-empty, never as a shrug",
    async () => {
      const response = await overview(readerFor({ [ids.liveRunId]: CALM }));

      const overviewBody = await body(response);
      expect(overviewBody.experiments).toEqual({ status: "ok", needingDecision: [], failing: [] });
      expect(overviewBody.environment.key).toBe("production");
    },
    ATTENTION_TEST_TIMEOUT,
  );

  it(
    "degrades a failed Analysis read to a retryable unknown, never to an empty list",
    async () => {
      const response = await overview(deadReader);

      expect(response.status).toBe(200);
      const overviewBody = await body(response);
      expect(overviewBody.experiments).toEqual({
        status: "unavailable",
        reason: "analysis_unavailable",
        retryable: true,
      });
      // The sections that do not depend on Analysis still answer.
      expect(overviewBody.environment.key).toBe("production");
      expect(overviewBody.flagConfiguration.recentlyChanged).toHaveLength(1);
    },
    ATTENTION_TEST_TIMEOUT,
  );
});

describe("panelOverviewRead refusals", () => {
  it(
    "refuses to call a corrupt Experiment retryable",
    async () => {
      // The dev Experiment names a live Run that does not exist; no wait repairs it.
      const response = await overview(readerFor({}), { environmentId: ids.devEnvironmentId });

      const overviewBody = await body(response);
      expect(overviewBody.experiments).toEqual({
        status: "unavailable",
        reason: "experiment_integrity",
        retryable: false,
      });
      expect(DEV_EXPERIMENT_ID).toBe("exp_attention_dev");
    },
    ATTENTION_TEST_TIMEOUT,
  );

  it(
    "refuses a budget-blown Environment without offering a retry that cannot help",
    async () => {
      const repo = repository();
      const scope = envScope(ids.appId, ids.environmentId);
      for (let index = 0; index <= OVERVIEW_ANALYSIS_READ_LIMIT; index += 1) {
        await repo.experiments.experiments.insert(scope, {
          id: `exp_budget_${index}`,
          appId: ids.appId,
          environmentId: ids.environmentId,
          key: `budget-${index}`,
          flagId: ids.flagId,
          name: `Budget ${index}`,
          status: "running",
          targetingKeyField: "userId",
          targetingKeyType: "user",
          metrics: "[]",
          guardrailMetrics: "[]",
          dimensions: "[]",
          liveRunId: `run_budget_${index}`,
          createdAt: NOW,
          updatedAt: NOW,
        });
      }

      let reads = 0;
      const counting: AnalysisResultsReader = {
        async read() {
          reads += 1;
          return CALM;
        },
      };
      const overviewBody = await body(await overview(counting));

      expect(overviewBody.experiments).toEqual({
        status: "unavailable",
        reason: "read_budget_exceeded",
        retryable: false,
      });
      // The budget is enforced before the reads it bounds, not after.
      expect(reads).toBe(0);
    },
    ATTENTION_TEST_TIMEOUT,
  );

  it(
    "reports only this Environment's Flag Configuration",
    async () => {
      const response = await overview(readerFor({ [ids.liveRunId]: CALM }));

      const overviewBody = await body(response);
      expect(overviewBody.flagConfiguration.recentlyChanged).toEqual([
        {
          flagId: ids.flagId,
          flagKey: ids.flagKey,
          flagName: "Checkout redesign",
          enabled: false,
          updatedAt: NOW,
        },
      ]);
    },
    ATTENTION_TEST_TIMEOUT,
  );

  it(
    "refuses an actor with no membership in the App",
    async () => {
      const response = await overview(readerFor({ [ids.liveRunId]: SIGNIFICANT }), {
        actorId: "user_outsider",
      });

      expect(response.status).toBe(403);
    },
    ATTENTION_TEST_TIMEOUT,
  );

  it(
    "refuses an Environment that belongs to a different App",
    async () => {
      const response = await overview(readerFor({ [ids.liveRunId]: SIGNIFICANT }), {
        appId: OTHER_APP_ID,
      });

      expect(response.status).toBe(404);
    },
    ATTENTION_TEST_TIMEOUT,
  );

  it(
    "never reads Analysis for a caller it has already refused",
    async () => {
      let reads = 0;
      const counting: AnalysisResultsReader = {
        async read() {
          reads += 1;
          return SIGNIFICANT;
        },
      };

      await overview(counting, { actorId: "user_outsider" });

      expect(reads).toBe(0);
    },
    ATTENTION_TEST_TIMEOUT,
  );

  it(
    "scopes the Run read to the Environment under request",
    async () => {
      // run_live belongs to production; asking dev for it must not resolve.
      const run = await repository().experiments.getRun(
        envScope(ids.appId, ids.devEnvironmentId),
        ids.liveRunId,
      );

      expect(run).toBeNull();
    },
    ATTENTION_TEST_TIMEOUT,
  );
});

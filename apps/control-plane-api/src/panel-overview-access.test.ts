import { envScope } from "@splitch/db";
import { describe, expect, it } from "vitest";
import type { AnalysisResultsReader } from "./attention-analysis-reader";
import {
  ATTENTION_TEST_TIMEOUT,
  DEV_EXPERIMENT_ID,
  repository,
  setupAttentionRollupFixture,
  USER_ID,
} from "./attention-rollup-fixture";
import { ids, NOW } from "./config-store-fixture-data";
import { OVERVIEW_ANALYSIS_READ_LIMIT } from "./overview-thresholds";
import { body, CALM, overview, readerFor, SIGNIFICANT } from "./panel-overview-fixture";

setupAttentionRollupFixture();

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
      // A member of the other App, so the read reaches the Environment-under-App
      // check instead of stopping at App membership.
      await repository().identity.createAppMembership({
        appId: ids.otherAppId,
        userId: USER_ID,
        role: "member",
        createdAt: NOW,
      });

      const response = await overview(readerFor({ [ids.liveRunId]: SIGNIFICANT }), {
        appId: ids.otherAppId,
      });

      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ message: "Environment not found" });
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

import { describe, expect, it } from "vitest";
import { ATTENTION_TEST_TIMEOUT, setupAttentionRollupFixture } from "./attention-rollup-fixture";
import { ids } from "./config-store-fixture-data";
import {
  body,
  CALM,
  deadReader,
  FAILING,
  overview,
  readerFor,
  SIGNIFICANT,
} from "./panel-overview-fixture";

setupAttentionRollupFixture();

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
        noData: [],
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
      expect(overviewBody.experiments).toEqual({
        status: "ok",
        needingDecision: [],
        failing: [],
        noData: [],
      });
      expect(overviewBody.environment.key).toBe("production");
    },
    ATTENTION_TEST_TIMEOUT,
  );

  it(
    "reports a running Experiment with no Analysis result as no_data, never as calm",
    async () => {
      // The read succeeds and returns nothing: the Run's state is not yet known.
      const overviewBody = await body(await overview(readerFor({})));

      expect(overviewBody.experiments).toEqual({
        status: "ok",
        needingDecision: [],
        failing: [],
        noData: [{ id: ids.experimentId, name: "Checkout experiment", runId: ids.liveRunId }],
      });
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

import { describe, expect, it, vi } from "vitest";
import { createControlPlaneSdk } from "./index";

const APP = "app_checkout";
const ENV = "env_production";
const EXPERIMENT = "exp_checkout";
const RUN = "run_checkout_1";

const preRegistration = {
  hypothesis: "Treatment raises signup rate",
  primaryMetricId: "metric_goal",
  metrics: [
    {
      metricId: "metric_goal",
      desirability: "higher_is_better" as const,
      rope: { lower: -0.01, upper: 0.01, scale: "absolute" as const },
    },
  ],
  shipRule: {
    requiredMargin: 0.02,
    marginScale: "absolute" as const,
    conflictResolution: "primary_wins" as const,
  },
};

const runLeaf = {
  id: RUN,
  experimentId: EXPERIMENT,
  environmentId: ENV,
  status: "running" as const,
  targetingKeyType: "user",
  salt: "salt-1",
  allocation: { control: 50, treatment: 50 },
  variantSet: [
    { id: "var_1", name: "control", value: false },
    { id: "var_2", name: "treatment", value: true },
  ],
  targetingRules: [],
  configHash: "hash-1",
  startedAt: "2026-06-28T00:00:00.000Z",
  endedAt: null,
  createdAt: "2026-06-28T00:00:00.000Z",
  preRegistration,
};

const approvalRequest = {
  id: "apr_01J00000000000000000000000",
  appId: APP,
  policyContexts: [
    {
      environmentId: ENV,
      changeTypes: ["enabled_state"],
      level: "confirm" as const,
    },
  ],
  operation: "experiment_winner_promote" as const,
  target: {
    type: "experiment_draft" as const,
    id: EXPERIMENT,
    version: `sha256:${"a".repeat(64)}`,
  },
  diff: {
    current: { enabled: false },
    proposed: { enabled: true },
    entries: [
      {
        path: "/enabled",
        operation: "replace" as const,
        current: false,
        proposed: true,
      },
    ],
  },
  status: "pending" as const,
  proposer: { userId: "user_1", authDoor: "id_jag" as const },
  proposedAt: "2026-07-29T12:00:00.000Z",
  resolvedAt: null,
  applicationResult: null,
  latestReview: null,
};

describe("SDK Start / Conclude response parsing preserves preRegistration", () => {
  it("keeps frozen preRegistration on experiments_start", async () => {
    const sdk = createControlPlaneSdk({
      baseUrl: "https://control-plane.test",
      fetch: vi.fn(async () =>
        Response.json({
          experimentId: EXPERIMENT,
          run: runLeaf,
          previousRunId: null,
          approvalRequest: null,
          frozenTargetingRules: [],
          runSnapshotShipped: true,
        }),
      ),
    });

    const result = await sdk.experiments.start({
      appId: APP,
      environmentId: ENV,
      experimentId: EXPERIMENT,
      idempotency_key: "idem-start-prereg",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.run.preRegistration).toEqual(preRegistration);
  });

  it("keeps frozen preRegistration on runs_conclude", async () => {
    const sdk = createControlPlaneSdk({
      baseUrl: "https://control-plane.test",
      fetch: vi.fn(async () =>
        Response.json({
          run: { ...runLeaf, status: "ended", endedAt: "2026-07-29T12:00:00.000Z" },
          conclusion: {
            id: "conclusion_1",
            runId: RUN,
            selectedVariant: "treatment",
            resultToken: `sha256:${"b".repeat(64)}`,
            dataWatermark: "2026-07-29T12:00:00.000Z",
            concludedAt: "2026-07-29T12:00:00.000Z",
          },
          approvalRequest,
        }),
      ),
    });

    const result = await sdk.experiments.conclude({
      appId: APP,
      environmentId: ENV,
      experimentId: EXPERIMENT,
      runId: RUN,
      selectedVariant: "treatment",
      expectedResultToken: `sha256:${"b".repeat(64)}`,
      dataWatermark: "2026-07-29T12:00:00.000Z",
      target: {
        environmentId: ENV,
        flagId: "flag_checkout",
        expectedConfigVersion: 1,
        proposedConfig: {
          enabled: true,
          availableVariantNames: ["control", "treatment"],
          targetingRules: [],
          rollout: { percentage: 100 },
        },
      },
      idempotencyKey: "idem-conclude-prereg",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.run.preRegistration).toEqual(preRegistration);
  });
});

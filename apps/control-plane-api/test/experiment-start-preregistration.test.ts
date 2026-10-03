import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createExperimentDraft,
  type ExperimentRunHarness,
  experimentFixture,
  makeExperimentRunHarness,
  startExperiment,
} from "../src/experiment-run-test-fixture";
import { makePoolBindings as makeLocalBindings } from "./pool-bindings";

let ctx: ExperimentRunHarness;

beforeEach(async () => {
  ctx = await makeExperimentRunHarness(makeLocalBindings);
});

afterEach(async () => ctx.h.bindings.dispose());

const validShipRule = {
  requiredMargin: 0.02,
  marginScale: "absolute" as const,
  conflictResolution: "primary_wins" as const,
};

describe("experiments_start pre-registration validation codes", () => {
  it("returns PREREG_HYPOTHESIS_REQUIRED for an empty hypothesis", async () => {
    const fx = await experimentFixture(ctx);
    const experiment = await createExperimentDraft(ctx, fx, {
      key: "prereg-hypothesis",
      allocation: { control: 50, treatment: 50 },
      salt: "prereg-hypothesis-salt",
    });

    const response = await startExperiment(ctx, fx, experiment.id, {
      preRegistration: {
        hypothesis: "",
        primaryMetricId: fx.metricId,
        metrics: [{ metricId: fx.metricId, desirability: "higher_is_better" }],
        shipRule: validShipRule,
      },
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      code: string;
      details: { issues: Array<{ code?: string; path: string[] }> };
    };
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(body.details.issues.map((issue) => issue.code)).toContain("PREREG_HYPOTHESIS_REQUIRED");
  });

  it("returns PREREG_SHIP_RULE_INVALID for a zero requiredMargin", async () => {
    const fx = await experimentFixture(ctx);
    const experiment = await createExperimentDraft(ctx, fx, {
      key: "prereg-ship-rule",
      allocation: { control: 50, treatment: 50 },
      salt: "prereg-ship-rule-salt",
    });

    const response = await startExperiment(ctx, fx, experiment.id, {
      preRegistration: {
        hypothesis: "Treatment raises the goal",
        primaryMetricId: fx.metricId,
        metrics: [{ metricId: fx.metricId, desirability: "higher_is_better" }],
        shipRule: { ...validShipRule, requiredMargin: 0 },
      },
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      code: string;
      details: { issues: Array<{ code?: string; path: string[] }> };
    };
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(body.details.issues.map((issue) => issue.code)).toContain("PREREG_SHIP_RULE_INVALID");
  });
});

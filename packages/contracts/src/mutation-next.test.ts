import { describe, expect, it } from "vitest";
import { getRoute } from "./route-registry";
import {
  MutationNextSchema,
  nextAfterExperimentStart,
  nextAfterFlagShip,
  nextAfterPendingApproval,
} from "./mutation-next";

describe("MutationNextSchema", () => {
  it("accepts the documented shape and rejects an empty tool", () => {
    expect(
      MutationNextSchema.parse({
        tool: "experiment_results_get",
        reason: "poll",
        earliestAt: "2026-10-10T00:00:00.000Z",
        args: { experimentId: "exp_1" },
      }).tool,
    ).toBe("experiment_results_get");
    expect(MutationNextSchema.safeParse({ tool: "", reason: "x" }).success).toBe(false);
  });
});

describe("mutation next builders", () => {
  const cases = [
    nextAfterExperimentStart({
      appId: "app_1",
      environmentId: "env_1",
      experimentId: "exp_1",
      runId: "run_1",
      runStartedAt: "2026-10-03T00:00:00.000Z",
      plannedDurationDays: 7,
      targetN: 5000,
    }),
    nextAfterPendingApproval({ appId: "app_1", approvalRequestId: "apr_1" }),
    nextAfterFlagShip({
      appId: "app_1",
      environmentId: "env_1",
      flagKey: "checkout",
    }),
  ] as const;

  it("every emitted next.tool resolves to a registered routeRegistry operation", () => {
    for (const next of cases) {
      expect(getRoute(next.tool), next.tool).toBeDefined();
    }
  });

  it("computes earliestAt from the frozen planned duration", () => {
    expect(cases[0].earliestAt).toBe("2026-10-10T00:00:00.000Z");
    expect(cases[0].args?.targetN).toBe(5000);
  });
});

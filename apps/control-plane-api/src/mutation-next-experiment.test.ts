import { getRoute } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { nextAfterExperimentStart } from "./mutation-next-experiment";

describe("Experiment Start next builder", () => {
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
  ];

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

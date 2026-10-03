import { getRoute } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { emitNextAfterExperimentStart, emitNextAfterPendingApproval } from "./mutation-next-emit";

describe("mutation-next-emit", () => {
  it("emits registered tools for Start and pending Approval", () => {
    const start = emitNextAfterExperimentStart("app_1", {
      id: "run_1",
      experimentId: "exp_1",
      environmentId: "env_1",
      startedAt: "2026-10-03T00:00:00.000Z",
      plannedDurationDays: 7,
      targetN: 5000,
    });
    const pending = emitNextAfterPendingApproval("app_1", "apr_1");
    expect(getRoute(start.tool)).toBeDefined();
    expect(getRoute(pending.tool)).toBeDefined();
    expect(start.tool).toBe("experiment_results_get");
    expect(pending.tool).toBe("approval_request_reviews_create");
    expect(start.earliestAt).toBe("2026-10-10T00:00:00.000Z");
  });

  it("emits next for fixed-horizon Starts with null targetN", () => {
    const next = emitNextAfterExperimentStart("app_1", {
      id: "run_1",
      experimentId: "exp_1",
      environmentId: "env_1",
      startedAt: "2026-10-03T00:00:00.000Z",
      plannedDurationDays: 7,
      targetN: null,
    });
    expect(next.tool).toBe("experiment_results_get");
    expect(next.args?.targetN).toBeUndefined();
    expect(next.reason).toContain("fixed-horizon");
  });
});

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { mutationNext } from "./mutation-next";
import { parseResponseTolerantly } from "./parse-response-tolerantly";

/**
 * Compat note for plan 1.5 / #647: clients that have not yet regenerated against
 * schemas carrying `next` still accept additive mutation bodies by stripping
 * unknown keys through parseResponseTolerantly.
 */
describe("mutation next client compatibility", () => {
  it("strips additive next from a pre-1.5 Start-shaped schema", () => {
    const legacyStart = z
      .object({
        experimentId: z.string(),
        previousRunId: z.string().nullable(),
      })
      .strict();
    const next = mutationNext({
      tool: "experiment_results_get",
      reason:
        "Poll Experiment results after the frozen planned duration (7 days) and sequential target_n of 5000.",
      earliestAt: "2026-10-10T00:00:00.000Z",
      args: {
        appId: "app_1",
        environmentId: "env_1",
        experimentId: "exp_1",
        runId: "run_1",
        targetN: 5000,
      },
    });
    const parsed = parseResponseTolerantly(legacyStart, {
      experimentId: "exp_1",
      previousRunId: null,
      next,
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).toEqual({ experimentId: "exp_1", previousRunId: null });
    expect("next" in parsed.data).toBe(false);
  });
});

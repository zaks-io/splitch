import { z } from "zod";
import { describe, expect, it } from "vitest";
import { nextAfterExperimentStart } from "./mutation-next";
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
    const next = nextAfterExperimentStart({
      appId: "app_1",
      environmentId: "env_1",
      experimentId: "exp_1",
      runId: "run_1",
      runStartedAt: "2026-10-03T00:00:00.000Z",
      plannedDurationDays: 7,
      targetN: 5000,
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

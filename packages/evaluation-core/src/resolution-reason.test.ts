import { describe, expect, it } from "vitest";
import { resolutionReasonFor } from "./resolution-reason";

describe("resolutionReasonFor", () => {
  it.each([
    ["disabled", "DISABLED"],
    ["rule_match_direct", "TARGETING_MATCH"],
    ["rule_match_percentage", "TARGETING_MATCH"],
    ["holdover_replay", "CACHED"],
    ["no_match_default", "DEFAULT"],
    ["no_live_run", "DEFAULT"],
    ["null_experiment", "DEFAULT"],
    ["baseline_rollout", "SPLIT"],
    ["fresh_assignment", "SPLIT"],
  ] as const)("maps %s to %s", (kind, reason) => {
    expect(resolutionReasonFor(kind)).toBe(reason);
  });
});

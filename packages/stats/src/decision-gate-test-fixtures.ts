import {
  armResultFixture as armResult,
  statsOutputFixture as stats,
} from "@splitch/contracts/testing";
/**
 * Shared StatsOutput fixtures for the decision-gate suites.
 *
 * Kept in one place so the gate tests and the dimension-slice tests assert
 * against the same payload shape rather than two drifting hand-rolled ones.
 */
import type { FrozenControlIdentity, StatsOutput } from "@splitch/contracts";
import { evaluateExperimentDecisionGate } from "./decision-gate";
import type { PlannedDurationEvidence } from "./decision-gate-duration";

/** A Control the Run really froze, so cases exercise one variable at a time. */
function frozenControl(): FrozenControlIdentity {
  return { state: "frozen", variantId: "variant_control", variant: "control" };
}

/** A Run whose selected evidence already spans its default one-week plan. */
export function reachedDuration(
  overrides: Partial<PlannedDurationEvidence> = {},
): PlannedDurationEvidence {
  return {
    plannedDurationDays: 7,
    overrideReason: null,
    runStartedAt: "2026-07-01T00:00:00.000Z",
    dataWatermark: "2026-07-08T00:00:00.000Z",
    ...overrides,
  };
}

export function gateFor(
  stats: StatsOutput,
  control: FrozenControlIdentity = frozenControl(),
  duration: PlannedDurationEvidence = reachedDuration(),
) {
  return evaluateExperimentDecisionGate(stats, control, duration);
}

export function check(output: ReturnType<typeof gateFor>, id: string) {
  const found = output.checks.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`gate is missing check ${id}`);
  return found;
}

export { armResult, stats };

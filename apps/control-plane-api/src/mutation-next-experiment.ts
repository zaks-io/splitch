import { type MutationNext, mutationNext } from "@splitch/contracts";
import { earliestDecisionWatermark } from "@splitch/stats";

/** After a committed Start: poll results at the planned-duration floor. */
export function nextAfterExperimentStart(input: {
  appId: string;
  environmentId: string;
  experimentId: string;
  runId: string;
  runStartedAt: string;
  plannedDurationDays: number;
  /** Frozen sequential target_n; null on fixed-horizon Runs. */
  targetN: number | null;
}): MutationNext {
  const duration = `${input.plannedDurationDays} day${input.plannedDurationDays === 1 ? "" : "s"}`;
  const targetPart =
    input.targetN === null
      ? " (fixed-horizon Run; no sequential target_n)"
      : ` and sequential target_n of ${input.targetN}`;
  return mutationNext({
    tool: "experiment_results_get",
    reason: `Poll Experiment results after the frozen planned duration (${duration})${targetPart}.`,
    earliestAt: earliestDecisionWatermark(input.runStartedAt, input.plannedDurationDays),
    args: {
      appId: input.appId,
      environmentId: input.environmentId,
      experimentId: input.experimentId,
      runId: input.runId,
      ...(input.targetN !== null ? { targetN: input.targetN } : {}),
    },
  });
}

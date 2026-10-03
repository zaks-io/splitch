import { z } from "zod";
import { earliestDecisionWatermark } from "./experiment-decision-gate-duration";

/**
 * Optional agent hint on a successful mutation response (plan 1.5).
 * Omitted when the next step is not determinable — never a guess.
 * `tool` must be a registered `routeRegistry` operationId (enforced where emitted
 * and by contract tests; not refined here to avoid a route-registry import cycle).
 */
export const MutationNextSchema = z
  .object({
    tool: z.string().min(1),
    reason: z.string().min(1),
    earliestAt: z.string().datetime({ offset: true }).optional(),
    args: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  })
  .strict();

export type MutationNext = z.infer<typeof MutationNextSchema>;

/** Build a validated `next` member. */
export function mutationNext(input: {
  tool: string;
  reason: string;
  earliestAt?: string;
  args?: Record<string, string | number | boolean>;
}): MutationNext {
  return MutationNextSchema.parse({
    tool: input.tool,
    reason: input.reason,
    ...(input.earliestAt !== undefined ? { earliestAt: input.earliestAt } : {}),
    ...(input.args !== undefined ? { args: input.args } : {}),
  });
}

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

/** After a mutation that left a pending Approval Request. */
export function nextAfterPendingApproval(input: {
  appId: string;
  approvalRequestId: string;
}): MutationNext {
  return mutationNext({
    tool: "approval_request_reviews_create",
    reason: "Review the pending Approval Request before the proposed change can apply.",
    args: {
      appId: input.appId,
      id: input.approvalRequestId,
    },
  });
}

/** After a Flag Configuration write or Promotion that landed. */
export function nextAfterFlagShip(input: {
  appId: string;
  environmentId: string;
  flagKey: string;
}): MutationNext {
  return mutationNext({
    tool: "flags_test_eval",
    reason: "Dry-run evaluate the shipped Flag Configuration without firing an Exposure.",
    args: {
      appId: input.appId,
      environmentId: input.environmentId,
      flagKey: input.flagKey,
    },
  });
}

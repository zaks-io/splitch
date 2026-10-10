import { z } from "zod";

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

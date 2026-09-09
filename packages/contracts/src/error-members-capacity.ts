import { z } from "zod";
import { ApprovalRequestIdSchema } from "./approval-identifiers";
import type { ErrorCode } from "./error-code";

export const capacityErrorMembers = [
  member(
    "QUOTA_EXCEEDED",
    z.object({
      resourceType: z.literal("organization"),
      currentCount: z.number().int().nonnegative(),
      ceiling: z.number().int().positive(),
      recommendedAction: z.literal("REDUCE_OWNED_ORGANIZATIONS"),
    }),
  ),
  member("RATE_LIMITED", z.object({ retryAfterMs: z.number() })),
  member(
    "SERVICE_UNAVAILABLE",
    z.object({
      retryAfterMs: z.number(),
      mutationCommitted: z.literal(true).optional(),
      conclusionId: z.string().optional(),
      approvalRequestId: ApprovalRequestIdSchema.optional(),
    }),
  ),
] as const;

function member<C extends ErrorCode, D extends z.ZodTypeAny>(code: C, details: D) {
  return z.object({ code: z.literal(code), message: z.string(), details });
}

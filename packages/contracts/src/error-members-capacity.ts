import { z } from "zod";
import { ApprovalRequestIdSchema } from "./approval-identifiers";
import { errorMember as member } from "./error-member";

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

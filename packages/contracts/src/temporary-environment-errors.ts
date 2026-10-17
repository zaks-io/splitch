import { z } from "zod";
import { errorMember as member } from "./error-member";

export const temporaryEnvironmentErrorMembers = [
  member(
    "ENVIRONMENT_EXPIRED",
    z.object({
      environmentId: z.string().min(1),
      expiredAt: z.iso.datetime({ offset: true }),
      recommendedAction: z.literal("CREATE_TEMPORARY_ENVIRONMENT"),
    }),
  ),
  member(
    "ENVIRONMENT_KIND_UNSUPPORTED",
    z.object({
      environmentId: z.string().min(1),
      temporary: z.boolean(),
      attemptedOp: z.string().min(1),
    }),
  ),
  member(
    "TEMPORARY_ENVIRONMENT_LIMIT_EXCEEDED",
    z.object({
      appId: z.string().min(1),
      limit: z.number().int().positive(),
      active: z.number().int().nonnegative(),
      nextExpiresAt: z.iso.datetime({ offset: true }),
      recommendedAction: z.literal("DELETE_TEMPORARY_ENVIRONMENT"),
    }),
  ),
  member(
    "SYNC_LIMIT_EXCEEDED",
    z.object({
      appId: z.string().min(1),
      limit: z.number().int().positive(),
      flags: z.number().int().nonnegative(),
    }),
  ),
  member(
    "ENVIRONMENT_SYNC_INCOMPLETE",
    z.object({
      environmentId: z.string().min(1),
      fromEnvironmentId: z.string().min(1),
      applied: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      failedFlagIds: z.array(z.string().min(1)).max(50),
      retryAfterMs: z.number().int().nonnegative(),
    }),
  ),
] as const;

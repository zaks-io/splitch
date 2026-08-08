import { z } from "zod";
import type { ErrorCode } from "./error-code";
import { UserRoleSchema } from "./leaf-schemas-runtime";

/**
 * Organization-domain error members: the conflicts a caller hits when naming an
 * Organization or changing who belongs to it. They sit beside the canonical
 * union in `errors.ts` rather than inside it, which is how that file stays
 * within the module-size budget as the vocabulary grows.
 */

/**
 * The slug is a GLOBAL handle, so a conflict can name a resource the caller
 * cannot see. `conflictingSlug` echoes only what the caller already sent; no
 * id, name, or owner of the winning resource is disclosed (ADR-0018).
 */
const SlugConflictDetailsSchema = z.object({
  resourceType: z.literal("organization"),
  conflictingSlug: z.string(),
  // A slug collision has exactly one remedy. The open enum would let an
  // unrelated action typecheck here and send a caller somewhere useless.
  recommendedAction: z.literal("CHOOSE_DIFFERENT_SLUG"),
});

export const organizationErrorMembers = {
  slugConflict: member("SLUG_CONFLICT", SlugConflictDetailsSchema),
  membershipConflict: member("MEMBERSHIP_CONFLICT", z.object({ existingRole: UserRoleSchema })),
  lastOwnerRequired: member("LAST_OWNER_REQUIRED", z.object({ orgId: z.string() })),
} as const;

function member<C extends ErrorCode, D extends z.ZodTypeAny>(code: C, details: D) {
  return z.object({
    code: z.literal(code),
    message: z.string(),
    details,
  });
}

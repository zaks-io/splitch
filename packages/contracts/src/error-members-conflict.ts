import { z } from "zod";
import type { ErrorCode } from "./error-code";
import { UserRoleSchema } from "./leaf-schemas-runtime";

/**
 * Uniqueness-conflict ErrorResponse members. Split from `errors.ts` so that
 * file stays under the file-size ratchet (300 code lines); the members here are
 * ordinary conflict details, not a separate error domain.
 */
export const conflictErrorMembers = [
  // The slug is a GLOBAL handle, so a conflict can name a resource the caller
  // cannot see. `conflictingSlug` echoes only what the caller already sent; no
  // id, name, or owner of the winning resource is disclosed (ADR-0018).
  member(
    "SLUG_CONFLICT",
    z.object({
      resourceType: z.literal("organization"),
      conflictingSlug: z.string(),
      // A slug collision has exactly one remedy. The open enum would let an
      // unrelated action typecheck here and send a caller somewhere useless.
      recommendedAction: z.literal("CHOOSE_DIFFERENT_SLUG"),
    }),
  ),
  member("MEMBERSHIP_CONFLICT", z.object({ existingRole: UserRoleSchema })),
  // An Experiment (live or archived) still holds `(app, env, key)`. Naming an
  // archived id is safe: the caller has Environment write scope and owned it.
  // Live holders omit archivedExperimentId and surface status instead.
  member(
    "EXPERIMENT_KEY_CONFLICT",
    z.object({
      key: z.string(),
      status: z.enum(["draft", "running", "ended", "archived"]),
      archivedExperimentId: z.string().optional(),
      recommendedAction: z.literal("CHOOSE_DIFFERENT_KEY"),
    }),
  ),
] as const;

function member<C extends ErrorCode, D extends z.ZodTypeAny>(code: C, details: D) {
  return z.object({
    code: z.literal(code),
    message: z.string(),
    details,
  });
}

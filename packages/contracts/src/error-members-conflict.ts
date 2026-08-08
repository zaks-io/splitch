import { z } from "@hono/zod-openapi";
import type { ErrorCode } from "./error-code";

/**
 * Uniqueness / selector-collision ErrorResponse members. Kept beside the main
 * catalog so `errors.ts` stays under the file-size ratchet when a new conflict
 * code lands.
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
  // flags_get id-and-key collision (SPL-288): name both ids; never pick silently.
  member(
    "FLAG_SELECTOR_AMBIGUOUS",
    z.object({
      selector: z.string(),
      idMatchFlagId: z.string(),
      keyMatchFlagId: z.string(),
      recommendedAction: z.literal("PASS_CANONICAL_FLAG_ID"),
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

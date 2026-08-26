import { z } from "zod";
import type { ErrorCode } from "./error-code";
import { UserRoleSchema } from "./leaf-schemas-runtime";

/**
 * Uniqueness-conflict ErrorResponse members. Split from `errors.ts` so that
 * file stays under the file-size ratchet (300 code lines); the members here are
 * ordinary conflict details, not a separate error domain.
 */
export const conflictErrorMembers = [
  // An Organization slug is a GLOBAL handle and an App slug is unique within its
  // Organization, so a conflict can name a resource the caller cannot see.
  // `conflictingSlug` echoes only what the caller already sent; no id, name, or
  // owner of the winning resource is disclosed (ADR-0018).
  member(
    "SLUG_CONFLICT",
    z.object({
      resourceType: z.enum(["organization", "app"]),
      conflictingSlug: z.string(),
      // A slug collision has exactly one remedy. The open enum would let an
      // unrelated action typecheck here and send a caller somewhere useless.
      recommendedAction: z.literal("CHOOSE_DIFFERENT_SLUG"),
    }),
  ),
  member("MEMBERSHIP_CONFLICT", z.object({ existingRole: UserRoleSchema })),
  member(
    "IDEMPOTENCY_KEY_CONFLICT",
    z.object({
      scope: z.enum([
        "approval_request",
        "review",
        "conclusion",
        "app_create",
        "flag_create",
        "convex_installation",
        "convex_secret_rotation",
        "convex_evaluation",
        "cloudflare_installation",
        "sentry_installation",
        "sentry_secret_rotation",
      ]),
      idempotencyKey: z.string().min(1),
    }),
  ),
  // An Experiment (live or archived) still holds `(app, env, key)`. Naming an
  // archived id is safe: the caller has Environment write scope and owned it.
  // Live holders omit archivedExperimentId and surface status instead.
  // An Environment publishes Flag changes to exactly one Sentry organization:
  // Sentry's change-tracking payload has no environment axis, so a second
  // installation would silently interleave two Environments' toggles into one
  // audit log. Naming the holder is safe — the caller has App-admin scope on the
  // Environment that owns it.
  member(
    "SENTRY_INSTALLATION_CONFLICT",
    z.object({
      activeInstallationId: z.string().min(1),
      recommendedAction: z.literal("REVOKE_ACTIVE_INSTALLATION"),
    }),
  ),
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

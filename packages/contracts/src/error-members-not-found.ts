import { z } from "zod";
import type { ErrorCode } from "./error-code";
import { SegmentNotFoundDetailsSchema } from "./segment-error-details";

/**
 * Resource-not-found ErrorResponse members. Split from `errors.ts` so that file
 * stays under the file-size ratchet (300 code lines); these are ordinary 404
 * members, not a separate error domain.
 */

const EmptyDetails = z.object({}).strict();

export const notFoundErrorMembers = [
  member("EXPERIMENT_NOT_FOUND", EmptyDetails),
  member("RUN_NOT_FOUND", EmptyDetails),
  member("FLAG_NOT_FOUND", EmptyDetails),
  member("VARIANT_NOT_FOUND", EmptyDetails),
  member("METRIC_NOT_FOUND", EmptyDetails),
  member("APP_NOT_FOUND", EmptyDetails),
  member("ENVIRONMENT_NOT_FOUND", EmptyDetails),
  member("ORGANIZATION_NOT_FOUND", EmptyDetails),
  member("USER_NOT_FOUND", EmptyDetails),
  member("CREDENTIAL_NOT_FOUND", EmptyDetails),
  member("SEGMENT_NOT_FOUND", SegmentNotFoundDetailsSchema),
  member("PRIVACY_JOB_NOT_FOUND", EmptyDetails),
  member("APPROVAL_REQUEST_NOT_FOUND", EmptyDetails),
] as const;

function member<C extends ErrorCode, D extends z.ZodTypeAny>(code: C, details: D) {
  return z.object({
    code: z.literal(code),
    message: z.string(),
    details,
  });
}

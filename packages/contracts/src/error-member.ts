import { z } from "zod";
import type { ErrorCode } from "./error-code";
import { ErrorOutcomeSchema } from "./error-outcome";

/**
 * One member of the ErrorResponse union. `outcome` is optional because a few
 * renderers (Event Ingest's local error path) do not stamp it yet; every
 * `presentErrorResponse` body carries it.
 */
export function errorMember<C extends ErrorCode, D extends z.ZodTypeAny>(code: C, details: D) {
  return z.object({
    code: z.literal(code),
    message: z.string(),
    outcome: ErrorOutcomeSchema.optional(),
    details,
  });
}

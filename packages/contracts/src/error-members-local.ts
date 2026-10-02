import { z } from "zod";
import type { ErrorCode } from "./error-code";

/**
 * MCP-local refusals that used to reach the agent as an `isError` message with
 * no `code`. They are registered in the same ErrorResponse union as Worker
 * codes so CLI, docs, and recovery share one vocabulary.
 */

const ValidationIssue = z.object({
  path: z.array(z.string()),
  message: z.string(),
});

export const localErrorMembers = [
  member(
    "SCOPE_UNRESOLVED",
    z.object({
      parameter: z.string(),
      resource: z.enum(["App", "Environment"]),
    }),
  ),
  member("CONTEXT_USE_INVALID", z.object({ issues: z.array(ValidationIssue).min(1) })),
] as const;

function member<C extends ErrorCode, D extends z.ZodTypeAny>(code: C, details: D) {
  return z.object({
    code: z.literal(code),
    message: z.string(),
    details,
  });
}

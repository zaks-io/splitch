import { z } from "zod";
import type { ErrorCode } from "./error-code";

const EmptyDetails = z.object({}).strict();
const ValidationIssue = z.object({
  path: z.array(z.string()),
  message: z.string(),
});

export const eventErrorMembers = [
  member(
    "EVENT_SCHEMA_MISMATCH",
    z.object({
      eventName: z.string(),
      eventDefinitionVersionId: z.string().optional(),
      issues: z.array(ValidationIssue),
    }),
  ),
  member(
    "ENTITY_TYPE_MISMATCH",
    z.object({
      expectedIdType: z.string().nullable().optional(),
      receivedIdType: z.string(),
      eventDefinitionId: z.string().optional(),
      metricId: z.string().optional(),
      runId: z.string().optional(),
    }),
  ),
  member("EVENT_DEFINITION_NOT_FOUND", EmptyDetails),
  member("EVENT_DEFINITION_VERSION_NOT_FOUND", EmptyDetails),
  member(
    "EVENT_DEFINITION_UNPUBLISHED",
    z.object({ eventDefinitionId: z.string(), eventName: z.string() }),
  ),
  member(
    "EVENT_DEFINITION_IMMUTABLE",
    z.object({
      eventDefinitionId: z.string(),
      eventDefinitionVersionId: z.string(),
      attemptedOp: z.string(),
    }),
  ),
] as const;

function member<C extends ErrorCode, D extends z.ZodTypeAny>(code: C, details: D) {
  return z.object({ code: z.literal(code), message: z.string(), details });
}

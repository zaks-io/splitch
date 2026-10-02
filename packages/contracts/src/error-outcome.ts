import { z } from "zod";
import { type ErrorCode, errorCodes } from "./error-code";

/**
 * Uniform retry classification for every ErrorCode. This is not a second
 * recovery mechanism: `details.recommendedAction` stays the specific next
 * step when one exists. Agents branch on `outcome` to decide whether to
 * retry the same call, change something, or stop.
 */
export const errorOutcomes = ["retryable", "user_action_required", "non_retryable"] as const;

export const ErrorOutcomeSchema = z.enum(errorOutcomes);
export type ErrorOutcome = z.infer<typeof ErrorOutcomeSchema>;

export type PresentedError<T extends { readonly code: ErrorCode }> = T & {
  readonly outcome: ErrorOutcome;
};

const retryableCodes = ["RATE_LIMITED", "SERVICE_UNAVAILABLE", "INTERNAL_SERVER_ERROR"] as const;

const nonRetryableCodes = [
  "EVENT_DEFINITION_IMMUTABLE",
  "APPROVAL_REQUEST_RESOLVED",
  "ACTIVATION_NOT_AVAILABLE",
] as const;

const retryable = new Set<string>(retryableCodes);
const nonRetryable = new Set<string>(nonRetryableCodes);

function outcomeForCode(code: ErrorCode): ErrorOutcome {
  if (retryable.has(code)) return "retryable";
  if (nonRetryable.has(code)) return "non_retryable";
  return "user_action_required";
}

export const errorOutcomeByCode = Object.fromEntries(
  errorCodes.map((code) => [code, outcomeForCode(code)]),
) as Record<ErrorCode, ErrorOutcome>;

export function presentErrorResponse<T extends { readonly code: ErrorCode }>(
  error: T,
): PresentedError<T> {
  return { ...error, outcome: errorOutcomeByCode[error.code] };
}

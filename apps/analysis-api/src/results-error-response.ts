import type { ErrorResponse } from "@splitch/contracts";
import {
  AnalysisIsolationError,
  AnalysisProvenanceError,
  ResultsForbiddenError,
  ResultsInputError,
  ResultsNotFoundError,
} from "./results-errors";
import { TinybirdReadError } from "./tinybird";

export function resultsErrorResponse(cause: unknown): ErrorResponse {
  if (cause instanceof ResultsNotFoundError) {
    return { code: cause.code, message: cause.message, details: {} };
  }
  if (cause instanceof ResultsForbiddenError) {
    return { code: "FORBIDDEN", message: cause.message, details: {} };
  }
  if (cause instanceof ResultsInputError || isZodError(cause)) {
    return {
      code: "VALIDATION_ERROR",
      message: "analysis inputs failed schema validation",
      details: { issues: zodOrInputIssues(cause) },
    };
  }
  if (cause instanceof TinybirdReadError) {
    return {
      code: "SERVICE_UNAVAILABLE",
      message: "analysis data is unavailable",
      details: { retryAfterMs: 30_000 },
    };
  }
  // A Run-provenance mismatch is a permanent integrity failure, not a blip.
  // Reporting it as retryable would invite a client to poll until a mislabelled
  // answer looked like a transient hiccup that had cleared.
  if (cause instanceof AnalysisProvenanceError) {
    return {
      code: "INTERNAL_SERVER_ERROR",
      message: "analysis run provenance mismatch",
      details: { fault: cause.message },
    };
  }
  if (cause instanceof AnalysisIsolationError) {
    return {
      code: "INTERNAL_SERVER_ERROR",
      message: "analysis isolation failure",
      details: { fault: cause.message },
    };
  }
  return {
    code: "INTERNAL_SERVER_ERROR",
    message: "analysis failed",
    details: { fault: faultMessage(cause) },
  };
}

interface ZodLikeError {
  issues: Array<{ path: PropertyKey[]; message: string }>;
}

function zodOrInputIssues(
  cause: ResultsInputError | ZodLikeError,
): Array<{ path: string[]; message: string }> {
  if (cause instanceof ResultsInputError) {
    return [{ path: ["analysis_run_inputs"], message: cause.message }];
  }
  return cause.issues.map((issue) => ({
    path: issue.path.map(String),
    message: issue.message,
  }));
}

function isZodError(cause: unknown): cause is ZodLikeError {
  return (
    typeof cause === "object" &&
    cause !== null &&
    (cause as { name?: unknown }).name === "ZodError" &&
    Array.isArray((cause as { issues?: unknown }).issues)
  );
}

function faultMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message.length > 0) return cause.message;
  return "unexpected analysis failure";
}

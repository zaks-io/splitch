import { ErrorCodeSchema, httpStatusForError } from "@splitch/contracts";
import { AnalysisResultsError } from "@splitch/control-plane-sdk/panel-experiments";

/**
 * Turns a failed Panel Experiments read into a refusal that says how permanent
 * it is.
 *
 * A caller cannot tell a transient outage from a broken integrity guarantee
 * from the outside, so the response has to. Reporting a Run-provenance mismatch
 * as "retry in 30s" would teach the caller to poll through a fault that polling
 * can never clear (ADR-0036). Typed Analysis error bodies pass through with
 * their details intact; HTTP status is taken from the error code, not the
 * upstream status line, so a permanent code that arrived as 503 stays permanent.
 * Early-Run collecting (`state: "no_data"`) is a 200 from Analysis and never
 * reaches this helper.
 */
export function panelAnalysisFailureResponse(cause: unknown): Response {
  if (cause instanceof AnalysisResultsError) {
    const code = ErrorCodeSchema.safeParse(cause.code);
    if (code.success) {
      return Response.json(
        {
          code: code.data,
          message: cause.message,
          details: cause.details,
        },
        { status: httpStatusForError(code.data) },
      );
    }
    if (!cause.retryable) {
      return Response.json(
        {
          code: "INTERNAL_SERVER_ERROR",
          message: "Experiment results could not be read safely",
          details: { fault: cause.message },
        },
        { status: 500 },
      );
    }
  }
  return Response.json(
    {
      code: "SERVICE_UNAVAILABLE",
      message: "Experiment data is unavailable",
      details: { retryAfterMs: 30_000 },
    },
    { status: 503 },
  );
}

import { ScopedAnalysisError } from "@splitch/control-plane-sdk/panel-experiments";

/**
 * Turns a failed Panel Experiments read into a refusal that says how permanent
 * it is.
 *
 * A caller cannot tell a transient outage from a broken integrity guarantee
 * from the outside, so the response has to. Reporting a Run-provenance mismatch
 * as "retry in 30s" would teach the caller to poll through a fault that polling
 * can never clear (ADR-0036).
 */
export function panelAnalysisFailureResponse(cause: unknown): Response {
  if (cause instanceof ScopedAnalysisError && !cause.retryable) {
    return Response.json(
      {
        code: "INTERNAL_SERVER_ERROR",
        message: "Experiment results could not be read safely",
        details: {},
      },
      { status: 500 },
    );
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

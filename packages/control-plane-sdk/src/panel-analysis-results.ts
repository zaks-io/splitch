import type { AnalysisResultsEnvelope, ErrorResponse } from "@splitch/contracts";
import { AnalysisResultsEnvelopeSchema, ErrorResponseSchema } from "@splitch/contracts";

/**
 * Reading one Run's results envelope back from the Analysis Worker.
 *
 * Split out of `panel-experiments.ts`: the Panel client speaks to the Control
 * Plane, this interprets what Analysis answered, and they share nothing but a
 * file. How the request got there is the delegation protocol in
 * @splitch/worker-runtime (ADR-0046); this is only the response side.
 */

/**
 * A refusal from the Analysis Worker, carried as a type rather than a string.
 *
 * `retryable` is the load-bearing field. A permanent integrity refusal that a
 * caller reports as "try again in 30s" teaches the caller to poll through a
 * fault that polling cannot clear (ADR-0036).
 */
export class AnalysisResultsError extends Error {
  readonly status: number;
  /** The Analysis Worker's own error code, when it sent a typed body. */
  readonly code: string | null;
  /** Structured details from the Analysis body; empty when the refusal was untyped. */
  readonly details: Record<string, unknown>;
  readonly retryable: boolean;

  constructor(
    status: number,
    message: string,
    code: string | null = null,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "AnalysisResultsError";
    this.status = status;
    this.code = code;
    this.details = details;
    // The typed body is the authority on whether waiting can help. Classifying
    // on the HTTP status alone would read a 500 carrying SERVICE_UNAVAILABLE as
    // a permanent fault, and a permanent integrity failure that happened to be
    // sent as a 503 as something worth polling.
    this.retryable = code === null ? TRANSIENT_STATUS.has(status) : TRANSIENT_CODES.has(code);
  }
}

const TRANSIENT_STATUS = new Set([429, 503]);
const TRANSIENT_CODES = new Set(["RATE_LIMITED", "SERVICE_UNAVAILABLE"]);

export async function parseAnalysisResults(
  response: Response,
  expectedRunId: string,
): Promise<Exclude<AnalysisResultsEnvelope, { state: "no_run" }>> {
  if (!response.ok) {
    throw await analysisFailure(response);
  }
  const envelope = AnalysisResultsEnvelopeSchema.parse(await response.json());
  // Analysis answers ready/no_data for a locked Run. `no_run` is resolved on the
  // Control Plane before the hop (SPL-305) and must not arrive from Analysis.
  if (envelope.state === "no_run") {
    throw new AnalysisResultsError(
      500,
      "analysis answered no_run; Control Plane resolves draft Experiments before the hop",
      "INTERNAL_SERVER_ERROR",
      {
        fault: "analysis answered no_run; Control Plane resolves draft Experiments before the hop",
      },
    );
  }
  // Numbers from one Run rendered under another Run's heading is the exact
  // failure the no-pooling guarantee exists to prevent, and no amount of
  // retrying turns it into the right Run.
  if (envelope.run_id !== expectedRunId) {
    throw new AnalysisResultsError(
      500,
      `analysis answered for Run ${envelope.run_id}, not Run ${expectedRunId}`,
      "INTERNAL_SERVER_ERROR",
      {
        fault: `analysis answered for Run ${envelope.run_id}, not Run ${expectedRunId}`,
      },
    );
  }
  return envelope;
}

/**
 * True when Analysis answered 200 `state: "no_data"`: a locked Run still
 * missing Exposures or Metric Events (SPL-302). Attention / list-health treat
 * this like RUN_NOT_FOUND; an explicit Results read surfaces `missing` to the
 * Panel waiting state.
 */
export function isAnalysisResultsNoData(
  envelope: AnalysisResultsEnvelope,
): envelope is Extract<AnalysisResultsEnvelope, { state: "no_data" }> {
  return envelope.state === "no_data";
}

/**
 * Legacy: older Analysis builds mapped insufficient inputs to VALIDATION_ERROR.
 * Prefer `isAnalysisResultsNoData` on 200 envelopes. Kept so attention / list
 * health do not regress to SERVICE_UNAVAILABLE against a mixed fleet.
 */
export function isAnalysisInsufficientData(
  error: Pick<AnalysisResultsError, "code" | "details"> | ErrorResponse,
): boolean {
  if (error.code !== "VALIDATION_ERROR") return false;
  const details = error.details;
  if (!details || typeof details !== "object" || !("issues" in details)) return false;
  const issues = (details as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) return false;
  return issues.some((issue) => {
    if (!issue || typeof issue !== "object" || !("path" in issue)) return false;
    const path = (issue as { path?: unknown }).path;
    // Exact single-element paths only. A Zod path like ["exposures", 0, "variant"]
    // is a schema fault, not the SPL-302 insufficient-data signal.
    return (
      Array.isArray(path) &&
      path.length === 1 &&
      (path[0] === "metric_events" || path[0] === "exposures")
    );
  });
}

/**
 * Turns a refusal from the Analysis Worker into a typed error.
 *
 * The body is read before the status is trusted: the Worker states plainly
 * whether the condition is temporary, and discarding that to guess from a
 * three-digit code throws away the only reliable signal we were sent.
 */
async function analysisFailure(response: Response): Promise<AnalysisResultsError> {
  const parsed = ErrorResponseSchema.safeParse(await readJson(response));
  if (!parsed.success) {
    return new AnalysisResultsError(
      response.status,
      `analysis results read failed with HTTP ${response.status}`,
      null,
      { fault: `untyped analysis refusal (HTTP ${response.status})` },
    );
  }
  return new AnalysisResultsError(
    response.status,
    parsed.data.message,
    parsed.data.code,
    parsed.data.details as Record<string, unknown>,
  );
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

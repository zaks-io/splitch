import type { AnalysisResultsEnvelope } from "@splitch/contracts";
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
  readonly retryable: boolean;

  constructor(status: number, message: string, code: string | null = null) {
    super(message);
    this.name = "AnalysisResultsError";
    this.status = status;
    this.code = code;
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
): Promise<AnalysisResultsEnvelope> {
  if (!response.ok) {
    throw await analysisFailure(response);
  }
  const envelope = AnalysisResultsEnvelopeSchema.parse(await response.json());
  // Numbers from one Run rendered under another Run's heading is the exact
  // failure the no-pooling guarantee exists to prevent, and no amount of
  // retrying turns it into the right Run.
  if (envelope.run_id !== expectedRunId) {
    throw new AnalysisResultsError(
      500,
      `analysis answered for Run ${envelope.run_id}, not Run ${expectedRunId}`,
    );
  }
  return envelope;
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
    );
  }
  return new AnalysisResultsError(response.status, parsed.data.message, parsed.data.code);
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

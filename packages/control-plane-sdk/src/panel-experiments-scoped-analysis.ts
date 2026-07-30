import type { AnalysisResultsEnvelope } from "@splitch/contracts";
import { AnalysisResultsEnvelopeSchema, ErrorResponseSchema } from "@splitch/contracts";

/**
 * The scoped service-identity protocol the Control Plane uses to read one Run's
 * results out of the Analysis Worker.
 *
 * Split out of `panel-experiments.ts`: the Panel client speaks to the Control
 * Plane, this speaks to Analysis, and they share nothing but a file. Both ends
 * of the protocol live here — the request the Control Plane mints and the
 * header the Analysis Worker parses — so the two cannot drift apart.
 */

export const SCOPED_SERVICE_IDENTITY_HEADER = "x-splitch-scoped-service-identity";

export interface ScopedAnalysisIdentity {
  operation: "experiment_results_post";
  actorId: string;
  appId: string;
  environmentId: string;
  experimentId: string;
  runId: string;
}

export function scopedAnalysisResultsRequest(identity: ScopedAnalysisIdentity): Request {
  return new Request(
    `https://analysis.internal/apps/${encodeURIComponent(identity.appId)}/envs/${encodeURIComponent(identity.environmentId)}/experiments/${encodeURIComponent(identity.experimentId)}/results`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [SCOPED_SERVICE_IDENTITY_HEADER]: JSON.stringify(identity),
      },
      body: JSON.stringify({ runId: identity.runId }),
    },
  );
}

/**
 * A refusal from the Analysis Worker, carried as a type rather than a string.
 *
 * `retryable` is the load-bearing field. A permanent integrity refusal that a
 * caller reports as "try again in 30s" teaches the caller to poll through a
 * fault that polling cannot clear (ADR-0036).
 */
export class ScopedAnalysisError extends Error {
  readonly status: number;
  /** The Analysis Worker's own error code, when it sent a typed body. */
  readonly code: string | null;
  readonly retryable: boolean;

  constructor(status: number, message: string, code: string | null = null) {
    super(message);
    this.name = "ScopedAnalysisError";
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

export async function parseScopedAnalysisResults(
  response: Response,
  expectedRunId: string,
): Promise<AnalysisResultsEnvelope> {
  if (!response.ok) {
    throw await scopedAnalysisFailure(response);
  }
  const envelope = AnalysisResultsEnvelopeSchema.parse(await response.json());
  // Numbers from one Run rendered under another Run's heading is the exact
  // failure the no-pooling guarantee exists to prevent, and no amount of
  // retrying turns it into the right Run.
  if (envelope.run_id !== expectedRunId) {
    throw new ScopedAnalysisError(
      500,
      `scoped analysis answered for Run ${envelope.run_id}, not Run ${expectedRunId}`,
    );
  }
  return envelope;
}

export function parseScopedAnalysisIdentity(value: string | null): ScopedAnalysisIdentity | null {
  if (!value) return null;
  try {
    const candidate = JSON.parse(value) as Record<string, unknown>;
    if (
      candidate.operation !== "experiment_results_post" ||
      !isNonEmptyString(candidate.actorId) ||
      !isNonEmptyString(candidate.appId) ||
      !isNonEmptyString(candidate.environmentId) ||
      !isNonEmptyString(candidate.experimentId) ||
      !isNonEmptyString(candidate.runId)
    ) {
      return null;
    }
    return candidate as unknown as ScopedAnalysisIdentity;
  } catch {
    return null;
  }
}

/**
 * Turns a refusal from the Analysis Worker into a typed error.
 *
 * The body is read before the status is trusted: the Worker states plainly
 * whether the condition is temporary, and discarding that to guess from a
 * three-digit code throws away the only reliable signal we were sent.
 */
async function scopedAnalysisFailure(response: Response): Promise<ScopedAnalysisError> {
  const parsed = ErrorResponseSchema.safeParse(await readJson(response));
  if (!parsed.success) {
    return new ScopedAnalysisError(
      response.status,
      `scoped analysis read failed with HTTP ${response.status}`,
    );
  }
  return new ScopedAnalysisError(response.status, parsed.data.message, parsed.data.code);
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

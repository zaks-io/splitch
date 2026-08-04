import {
  AnalysisResultsEnvelopeSchema,
  type ErrorResponse,
  ErrorResponseSchema,
  type StatsOutput,
} from "@splitch/contracts";
import { isAnalysisInsufficientData } from "@splitch/control-plane-sdk/panel-experiments";
import { type AnalysisResultsScope, analysisResultsRequest } from "./analysis-results-request";
import { ExperimentIntegrityError } from "./attention-rollup-errors";

/** The Analysis-results transport for the attention rollup: one read per running Run. */
export type { AnalysisResultsScope };

export interface AnalysisResultsReader {
  read(scope: AnalysisResultsScope, actorId: string): Promise<StatsOutput | null>;
}

export const unavailableAnalysisResults: AnalysisResultsReader = {
  async read() {
    throw new AnalysisResultsUnavailableError("analysis results binding is unavailable");
  },
};

interface FetcherLike {
  fetch(request: Request): Promise<Response>;
}

/**
 * Per-read bound on the Analysis service-binding fetch. Up to
 * ANALYSIS_READ_LIMIT (200) of these run at ANALYSIS_READ_CONCURRENCY (8) for
 * one rollup request; without this, one hung binding call would occupy a
 * concurrency slot for the platform's full subrequest duration and this
 * polled route would degrade to high tail latency instead of a fast,
 * structured SERVICE_UNAVAILABLE. 10s matches the route's polling cadence
 * (attention-rollup.ts is read repeatedly by agents/Panel, not once).
 */
const ANALYSIS_READ_TIMEOUT_MS = 10_000;

export function createAnalysisResultsReader(
  fetcher: FetcherLike,
  timeoutMs: number = ANALYSIS_READ_TIMEOUT_MS,
): AnalysisResultsReader {
  return {
    async read(scope, actorId) {
      let response: Response;
      try {
        response = await fetcher.fetch(
          new Request(analysisResultsRequest(scope, actorId), {
            signal: AbortSignal.timeout(timeoutMs),
          }),
        );
      } catch (cause) {
        throw new AnalysisResultsUnavailableError(cause);
      }
      return parseAnalysisResponse(response, scope.runId);
    },
  };
}

async function parseAnalysisResponse(
  response: Response,
  expectedRunId: string,
): Promise<StatsOutput | null> {
  if (!response.ok) {
    return refuseOrNull(await safeError(response), response.status);
  }
  return unwrapEnvelope(response, expectedRunId);
}

async function unwrapEnvelope(response: Response, expectedRunId: string): Promise<StatsOutput> {
  try {
    // Analysis answers with AnalysisResultsEnvelope ({ run_id, control_variant,
    // stats }), not bare StatsOutput. Parsing the envelope as StatsOutput fails
    // Zod and was promoted to SERVICE_UNAVAILABLE for every successful read
    // (SPL-290). Panel results already unwrap via parseAnalysisResults; this
    // reader must do the same and keep the no-pooling Run check.
    const envelope = AnalysisResultsEnvelopeSchema.parse(await response.json());
    // Match the Analysis Worker (results.ts): a Run-provenance mismatch is a
    // permanent integrity failure. Mapping it to AnalysisResultsUnavailableError
    // would render as retryable SERVICE_UNAVAILABLE and teach a polling agent to
    // wait out a fault that waiting cannot clear (ADR-0036 / SPL-290 review).
    if (envelope.run_id !== expectedRunId) {
      throw new ExperimentIntegrityError(
        `analysis answered for Run ${envelope.run_id}, not Run ${expectedRunId}`,
      );
    }
    return envelope.stats;
  } catch (cause) {
    if (cause instanceof AnalysisResultsUnavailableError) throw cause;
    if (cause instanceof ExperimentIntegrityError) throw cause;
    throw new AnalysisResultsUnavailableError(cause);
  }
}

function refuseOrNull(error: ErrorResponse | { status: number }, status: number): null {
  if (status === 404 && isMissingAnalysisResult(error)) return null;
  // Exposures without Metric Events (or vice versa) is an early-Run state,
  // not an Analysis outage. Treating it as unavailable would regress the
  // attention rollup to SERVICE_UNAVAILABLE (SPL-290 / SPL-302).
  if (isInsufficientAnalysisData(error)) return null;
  throw new AnalysisResultsUnavailableError(error);
}

async function safeError(response: Response): Promise<ErrorResponse | { status: number }> {
  try {
    const parsed = ErrorResponseSchema.safeParse(await response.json());
    if (parsed.success) return parsed.data;
  } catch {
    // The error is deliberately collapsed at this internal boundary.
  }
  return { status: response.status };
}

function isMissingAnalysisResult(
  error: ErrorResponse | { status: number },
): error is Extract<ErrorResponse, { code: "EXPERIMENT_NOT_FOUND" | "RUN_NOT_FOUND" }> {
  return (
    "code" in error && (error.code === "EXPERIMENT_NOT_FOUND" || error.code === "RUN_NOT_FOUND")
  );
}

function isInsufficientAnalysisData(
  error: ErrorResponse | { status: number },
): error is Extract<ErrorResponse, { code: "VALIDATION_ERROR" }> {
  return "code" in error && isAnalysisInsufficientData(error);
}

/**
 * A `running` Experiment with no `liveRunId` is a corrupt row, not an outage.
 * Kept distinct from AnalysisResultsUnavailableError so it can never be rendered
 * as a retryable SERVICE_UNAVAILABLE: no amount of waiting repairs the row, and a
 * polling agent told to retry would poll a permanent fault forever.
 */
export class AnalysisResultsUnavailableError extends Error {
  constructor(readonly detail: unknown) {
    super("analysis results unavailable");
    this.name = "AnalysisResultsUnavailableError";
  }
}

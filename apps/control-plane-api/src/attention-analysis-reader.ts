import {
  type ErrorResponse,
  ErrorResponseSchema,
  type StatsOutput,
  StatsOutputSchema,
} from "@splitch/contracts";
import { type AnalysisResultsScope, analysisResultsRequest } from "./analysis-results-request";

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
      return parseAnalysisResponse(response);
    },
  };
}

async function parseAnalysisResponse(response: Response): Promise<StatsOutput | null> {
  if (!response.ok) {
    const error = await safeError(response);
    if (response.status === 404 && isMissingAnalysisResult(error)) return null;
    throw new AnalysisResultsUnavailableError(error);
  }
  try {
    return StatsOutputSchema.parse(await response.json());
  } catch (cause) {
    throw new AnalysisResultsUnavailableError(cause);
  }
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

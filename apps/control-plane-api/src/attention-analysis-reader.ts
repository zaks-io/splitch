import {
  type ErrorResponse,
  ErrorResponseSchema,
  type StatsOutput,
  StatsOutputSchema,
} from "@splitch/contracts";
import { scopedAnalysisResultsRequest } from "@splitch/control-plane-sdk/panel-experiments";

/** The Analysis-results transport for the attention rollup: one read per running Run. */
export interface AnalysisResultsScope {
  appId: string;
  environmentId: string;
  experimentId: string;
  runId: string;
}

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

export function createAnalysisResultsReader(fetcher: FetcherLike): AnalysisResultsReader {
  return {
    async read(scope, actorId) {
      let response: Response;
      try {
        response = await fetcher.fetch(
          scopedAnalysisResultsRequest({
            operation: "experiment_results_post",
            actorId,
            ...scope,
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

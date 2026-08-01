import type { AssembledExposure } from "./evaluate/exposure-assembly";
import type { EvaluationUsageEvent } from "./evaluation-usage-sink";

export interface EvaluationCommitEvent {
  readonly usage: EvaluationUsageEvent;
  readonly exposures: readonly AssembledExposure[];
}

export interface EvaluationCommitSink {
  write(event: EvaluationCommitEvent): Promise<void>;
}

type FetcherLike =
  | typeof fetch
  | {
      fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
    };

/**
 * Which stage of the commit failed. Every one of these returns the same
 * SERVICE_UNAVAILABLE to the caller (a public Client Key must not learn how the
 * platform is wired), so this code is the only thing that tells an operator a
 * missing secret from an unreachable binding from ingest rejecting the write.
 * Without it all four collapsed into one log line and the deploy that broke
 * Exposure delivery read the same as a transient network blip.
 */
export type EvaluationCommitSinkFailure =
  | "ingest_token_missing"
  | "ingest_binding_missing"
  | "ingest_transport_failed"
  | "ingest_rejected";

export class EvaluationCommitSinkError extends Error {
  readonly failure: EvaluationCommitSinkFailure;
  /** Upstream HTTP status; null unless ingest answered. */
  readonly status: number | null;

  constructor(
    failure: EvaluationCommitSinkFailure,
    message: string,
    options?: ErrorOptions & { status?: number },
  ) {
    super(message, options);
    this.name = "EvaluationCommitSinkError";
    this.failure = failure;
    this.status = options?.status ?? null;
  }
}

export function makeHttpEvaluationCommitSink(options: {
  endpoint?: string;
  fetcher?: FetcherLike;
  token?: string;
}): EvaluationCommitSink {
  return {
    async write(event) {
      if (!options.token) {
        throw new EvaluationCommitSinkError(
          "ingest_token_missing",
          "internal ingest token is unavailable",
        );
      }
      if (options.fetcher === undefined && options.endpoint === undefined) {
        throw new EvaluationCommitSinkError(
          "ingest_binding_missing",
          "Evaluation commit ingest binding is unavailable",
        );
      }

      let response: Response;
      try {
        response = await callFetcher(fetcherFor(options), requestUrl(options), {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.token}`,
            "content-type": "application/json",
            "x-splitch-app-id": event.usage.appId,
            "x-splitch-environment-id": event.usage.environmentId,
            "x-splitch-organization-id": event.usage.organizationId,
          },
          body: JSON.stringify({ ...event.usage, exposures: event.exposures }),
        });
      } catch (cause) {
        throw new EvaluationCommitSinkError(
          "ingest_transport_failed",
          "Evaluation commit ingest transport failed",
          { cause },
        );
      }

      if (!response.ok) {
        throw new EvaluationCommitSinkError(
          "ingest_rejected",
          `Evaluation commit ingest returned HTTP ${response.status}`,
          { status: response.status },
        );
      }
    },
  };
}

function requestUrl(options: { endpoint?: string; fetcher?: FetcherLike }): string {
  const endpoint = options.endpoint ?? "https://splitch-event-ingest.internal";
  return new URL("/api/internal/evaluation-commits", endpoint).toString();
}

function fetcherFor(options: { endpoint?: string; fetcher?: FetcherLike }): FetcherLike {
  return options.fetcher ?? fetch;
}

function callFetcher(
  fetcher: FetcherLike,
  input: RequestInfo | URL,
  init: RequestInit,
): Promise<Response> {
  return typeof fetcher === "function" ? fetcher(input, init) : fetcher.fetch(input, init);
}

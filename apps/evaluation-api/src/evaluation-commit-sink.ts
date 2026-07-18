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

export class EvaluationCommitSinkError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EvaluationCommitSinkError";
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
        throw new EvaluationCommitSinkError("internal ingest token is unavailable");
      }
      if (options.fetcher === undefined && options.endpoint === undefined) {
        throw new EvaluationCommitSinkError("Evaluation commit ingest binding is unavailable");
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
        throw new EvaluationCommitSinkError("Evaluation commit ingest transport failed", { cause });
      }

      if (!response.ok) {
        throw new EvaluationCommitSinkError(
          `Evaluation commit ingest returned HTTP ${response.status}`,
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

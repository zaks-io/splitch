export interface EvaluationUsageEvent {
  readonly idempotencyKey: string;
  readonly organizationId: string;
  readonly appId: string;
  readonly environmentId: string;
  readonly flagKey: string;
  readonly sdkRuntime: string;
  readonly evaluationCount: 0 | 1;
  readonly isBatch: false;
  readonly isCached: boolean;
  readonly hasExposure: boolean;
}

export interface EvaluationUsageSink {
  write(event: EvaluationUsageEvent): Promise<void>;
}

type FetcherLike =
  | typeof fetch
  | {
      fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
    };

export class EvaluationUsageSinkError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EvaluationUsageSinkError";
  }
}

export function makeHttpEvaluationUsageSink(options: {
  endpoint?: string;
  fetcher?: FetcherLike;
  token?: string;
}): EvaluationUsageSink {
  return {
    async write(event) {
      if (!options.token) {
        throw new EvaluationUsageSinkError("internal ingest token is unavailable");
      }
      if (options.fetcher === undefined && options.endpoint === undefined) {
        throw new EvaluationUsageSinkError("Evaluation usage ingest binding is unavailable");
      }

      let response: Response;
      try {
        response = await callFetcher(fetcherFor(options), requestUrl(options), {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.token}`,
            "content-type": "application/json",
            "x-splitch-app-id": event.appId,
            "x-splitch-environment-id": event.environmentId,
            "x-splitch-organization-id": event.organizationId,
          },
          body: JSON.stringify(event),
        });
      } catch (cause) {
        throw new EvaluationUsageSinkError("Evaluation usage ingest transport failed", { cause });
      }

      if (!response.ok) {
        throw new EvaluationUsageSinkError(
          `Evaluation usage ingest returned HTTP ${response.status}`,
        );
      }
    },
  };
}

function requestUrl(options: { endpoint?: string; fetcher?: FetcherLike }): string {
  const endpoint = options.endpoint ?? "https://splitch-event-ingest.internal";
  return new URL("/api/internal/evaluations", endpoint).toString();
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

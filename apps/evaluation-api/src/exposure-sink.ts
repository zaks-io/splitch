import type { AssembledExposure } from "./evaluate/exposure-assembly.js";

export interface ExposureSink {
  write(exposure: AssembledExposure): Promise<void>;
}

type FetcherLike =
  | typeof fetch
  | {
      fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
    };

export class ExposureSinkError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ExposureSinkError";
  }
}

export function makeHttpExposureSink(options: {
  endpoint?: string;
  fetcher?: FetcherLike;
  token?: string;
}): ExposureSink {
  return {
    async write(exposure) {
      if (!options.token) {
        throw new ExposureSinkError("internal ingest token is unavailable");
      }
      if (options.fetcher === undefined && options.endpoint === undefined) {
        throw new ExposureSinkError("Exposure ingest binding is unavailable");
      }

      const response = await callFetcher(fetcherFor(options), requestUrl(options), {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.token}`,
          "content-type": "application/json",
          "x-splitch-app-id": exposure.appId,
          "x-splitch-environment-id": exposure.environmentId,
        },
        body: JSON.stringify(exposure),
      });

      if (!response.ok) {
        throw new ExposureSinkError(`Exposure ingest returned HTTP ${response.status}`);
      }
    },
  };
}

function requestUrl(options: { endpoint?: string; fetcher?: FetcherLike }): string {
  const endpoint = options.endpoint ?? "https://splitch-event-ingest.internal";
  return new URL("/api/internal/exposures", endpoint).toString();
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

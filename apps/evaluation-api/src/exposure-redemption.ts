import type { AssembledExposure } from "./evaluate/exposure-assembly";

/**
 * Appends a sealed Exposure via Event Ingest's Exposure-only route
 * (`POST /api/internal/exposures`). Distinct from evaluate's combined commit path
 * (`/api/internal/evaluation-commits`); both land in the same Tinybird raw_events
 * pipeline. No Evaluation usage billing (ADR-0048).
 */
export interface ExposureIngestSink {
  write(exposure: AssembledExposure): Promise<void>;
}

export class ExposureIngestSinkError extends Error {
  constructor(message: string, options?: ErrorOptions & { readonly status?: number }) {
    super(message, options);
    this.name = "ExposureIngestSinkError";
    this.status = options?.status ?? null;
  }

  readonly status: number | null;
}

type FetcherLike =
  | typeof fetch
  | {
      fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
    };

export function makeHttpExposureIngestSink(options: {
  endpoint?: string;
  fetcher?: FetcherLike;
  token?: string;
}): ExposureIngestSink {
  return {
    async write(exposure) {
      if (!options.token) {
        throw new ExposureIngestSinkError("internal ingest token is unavailable");
      }
      if (options.fetcher === undefined && options.endpoint === undefined) {
        throw new ExposureIngestSinkError("Exposure ingest binding is unavailable");
      }

      let response: Response;
      try {
        response = await callFetcher(fetcherFor(options), requestUrl(options), {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.token}`,
            "content-type": "application/json",
            "x-splitch-app-id": exposure.appId,
            "x-splitch-environment-id": exposure.environmentId,
          },
          body: JSON.stringify(exposure),
        });
      } catch (cause) {
        throw new ExposureIngestSinkError("Exposure ingest transport failed", { cause });
      }

      if (!response.ok) {
        throw new ExposureIngestSinkError(`Exposure ingest returned HTTP ${response.status}`, {
          status: response.status,
        });
      }
    },
  };
}

/** Test seam: records sealed Exposures for in-process harness assertions. */
export class RecordingExposureIngestSink implements ExposureIngestSink {
  readonly writes: AssembledExposure[] = [];

  constructor(
    private readonly downstream?: { write(exposure: AssembledExposure): Promise<void> },
  ) {}

  async write(exposure: AssembledExposure): Promise<void> {
    this.writes.push(exposure);
    await this.downstream?.write(exposure);
  }
}

export async function ticketFingerprint(ticket: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ticket));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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

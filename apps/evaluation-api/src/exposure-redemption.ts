import type { AssembledExposure } from "./evaluate/exposure-assembly";

/**
 * Durable claim for one Exposure Ticket redemption retry identity (`exposureId`).
 * Recorded only after a successful seal so a failed ingest remains retryable.
 */
export type ExposureRedemptionLookup =
  | { readonly status: "missing" }
  | { readonly status: "matched" }
  | { readonly status: "conflict" };

export interface ExposureRedemptionClaimStore {
  lookup(input: {
    readonly appId: string;
    readonly environmentId: string;
    readonly exposureId: string;
    readonly ticketFingerprint: string;
  }): Promise<ExposureRedemptionLookup>;

  record(input: {
    readonly appId: string;
    readonly environmentId: string;
    readonly exposureId: string;
    readonly ticketFingerprint: string;
  }): Promise<void>;
}

/** In-memory claim store for unit harnesses (and single-isolate local runs). */
export class MemoryExposureRedemptionClaimStore implements ExposureRedemptionClaimStore {
  private readonly claims = new Map<string, string>();

  async lookup(input: {
    readonly appId: string;
    readonly environmentId: string;
    readonly exposureId: string;
    readonly ticketFingerprint: string;
  }): Promise<ExposureRedemptionLookup> {
    const existing = this.claims.get(claimKey(input.appId, input.environmentId, input.exposureId));
    if (existing === undefined) return { status: "missing" };
    if (existing === input.ticketFingerprint) return { status: "matched" };
    return { status: "conflict" };
  }

  async record(input: {
    readonly appId: string;
    readonly environmentId: string;
    readonly exposureId: string;
    readonly ticketFingerprint: string;
  }): Promise<void> {
    this.claims.set(
      claimKey(input.appId, input.environmentId, input.exposureId),
      input.ticketFingerprint,
    );
  }
}

/**
 * KV-backed claim store with a 24-hour TTL matching the ticket TTL window.
 * Concurrent first claims may both append; pipeline first-touch remains authoritative.
 */
export class KvExposureRedemptionClaimStore implements ExposureRedemptionClaimStore {
  constructor(private readonly kv: KVNamespace) {}

  async lookup(input: {
    readonly appId: string;
    readonly environmentId: string;
    readonly exposureId: string;
    readonly ticketFingerprint: string;
  }): Promise<ExposureRedemptionLookup> {
    const key = kvClaimKey(input.appId, input.environmentId, input.exposureId);
    const existing = await this.kv.get(key);
    if (existing === null) return { status: "missing" };
    if (existing === input.ticketFingerprint) return { status: "matched" };
    return { status: "conflict" };
  }

  async record(input: {
    readonly appId: string;
    readonly environmentId: string;
    readonly exposureId: string;
    readonly ticketFingerprint: string;
  }): Promise<void> {
    await this.kv.put(
      kvClaimKey(input.appId, input.environmentId, input.exposureId),
      input.ticketFingerprint,
      {
        expirationTtl: 24 * 60 * 60,
      },
    );
  }
}

function claimKey(appId: string, environmentId: string, exposureId: string): string {
  return `${appId}\u001f${environmentId}\u001f${exposureId}`;
}

function kvClaimKey(appId: string, environmentId: string, exposureId: string): string {
  return `exposure-redemption:${claimKey(appId, environmentId, exposureId)}`;
}

export async function ticketFingerprint(ticket: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ticket));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Appends a sealed Exposure through the same Event Ingest seam evaluate uses
 * (`/api/internal/exposures`), without Evaluation usage billing (ADR-0048).
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

/** Test seam: records sealed Exposures the same way evaluate's commit sink does. */
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

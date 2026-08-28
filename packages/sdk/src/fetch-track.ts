import type { TrackRequest, TrackResult, TransportFailure } from "./transport";

interface TrackFetchConfig {
  readonly credential: string;
  readonly fetchImpl: typeof fetch;
}

export async function postMetricEvent(
  config: TrackFetchConfig,
  url: URL,
  request: TrackRequest,
  signal: AbortSignal,
  readFailure: (response: Response) => Promise<TransportFailure>,
): Promise<TrackResult> {
  const response = await config.fetchImpl(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.credential}`,
      "content-type": "application/json",
      "x-splitch-sdk-runtime": "javascript",
    },
    body: JSON.stringify(request),
    signal,
  });
  if (!response.ok) return trackFailure(await readFailure(response));
  const body = (await response.json()) as Record<string, unknown>;
  if (
    body.accepted !== true ||
    typeof body.eventId !== "string" ||
    typeof body.duplicate !== "boolean"
  ) {
    throw new Error("Metric Event response did not match the track contract");
  }
  return {
    status: response.status,
    accepted: true,
    eventId: body.eventId,
    duplicate: body.duplicate,
  };
}

export function trackFailure(failure: TransportFailure): TrackResult {
  return {
    ...failure,
    accepted: false,
    eventId: null,
    duplicate: false,
  };
}

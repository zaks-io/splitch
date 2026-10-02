import { postMetricEvent } from "../fetch-track";
import type { TransportFailure } from "../transport";
import type { OfrepEvaluationContext, OfrepTrackingDetails } from "./types";

const EVENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export async function trackMetricEvent(
  config: {
    readonly credential: string;
    readonly endpoint: string;
    readonly fetchImpl: typeof fetch;
  },
  trackingEventName: string,
  context: OfrepEvaluationContext,
  details: OfrepTrackingDetails = {},
): Promise<void> {
  if (typeof context.targetingKey !== "string" || context.targetingKey.length === 0) {
    throw new Error("OFREP track requires context.targetingKey");
  }
  const eventId = eventIdFrom(details.eventId);
  const fields = fieldsFrom(details);
  const dimensions = dimensionsFrom(details);
  const result = await postMetricEvent(
    { credential: config.credential, fetchImpl: config.fetchImpl },
    new URL("/api/sdk/events", config.endpoint),
    {
      eventName: trackingEventName,
      targetingKey: context.targetingKey,
      idType: typeof context.idType === "string" ? context.idType : "user",
      eventId,
      fields,
      dimensions,
    },
    new AbortController().signal,
    readFailure,
  );
  if (result.status !== 200 && result.status !== 202) {
    throw new Error(result.errorMessage ?? "OFREP track failed");
  }
}

function eventIdFrom(eventId: unknown): string {
  if (eventId === undefined) {
    return crypto.randomUUID();
  }
  if (typeof eventId === "string" && EVENT_ID.test(eventId)) {
    return eventId;
  }
  throw new Error("OFREP track details.eventId must be a UUID when provided");
}

function fieldsFrom(
  details: OfrepTrackingDetails,
): Record<string, boolean | string | number | null> {
  if (details.value === undefined) {
    return {};
  }
  if (typeof details.value !== "number" || !Number.isFinite(details.value)) {
    throw new Error("OFREP track details.value must be a finite number when provided");
  }
  return { value: details.value };
}

function dimensionsFrom(details: OfrepTrackingDetails): Record<string, boolean | string | number> {
  const dimensions: Record<string, boolean | string | number> = {};
  for (const [name, value] of Object.entries(details)) {
    if (name === "value" || name === "eventId") continue;
    if (
      typeof value === "boolean" ||
      typeof value === "string" ||
      (typeof value === "number" && Number.isFinite(value))
    ) {
      dimensions[name] = value;
      continue;
    }
    throw new Error(`OFREP track details.${name} must be a boolean, string, or finite number`);
  }
  return dimensions;
}

async function readFailure(response: Response): Promise<TransportFailure> {
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return {
    status: response.status,
    errorCode: "SDK_TRANSPORT_NETWORK",
    errorMessage:
      typeof body.message === "string" ? body.message : `HTTP ${String(response.status)}`,
  };
}

import { ExposureEventSchema, type ExposureEvent } from "@splitch/contracts";
import { serviceUnavailable } from "./errors";
import { stringField, stringValue } from "./payload";
import type { CredentialScope, Env, RunScope, Outcome, Payload, TinybirdDelivery } from "./types";

const rawEventsDatasource = "raw_events";

export async function exposureEvent(
  payload: Payload,
  scope: CredentialScope,
  runScope: RunScope,
  env: Env,
): Promise<Outcome<ExposureEvent>> {
  const now = new Date(Date.now()).toISOString();
  const eventId = stringField(payload, "eventId");
  const eventType = stringField(payload, "type");
  const sourceId = stringValue(payload.sourceId) ?? env.SPLITCH_SOURCE_ID ?? "local";
  if (!eventId.ok) return eventId;
  if (!eventType.ok) return eventType;

  const candidate = {
    ...payload,
    appId: scope.appId,
    environmentId: scope.environmentId,
    runId: runScope.runId,
    idType: runScope.idType,
    sourceId,
    serverReceivedAt: now,
    ingestTs: now,
    dedupKey: await exposureDedupKey(
      payload,
      scope.appId,
      runScope,
      eventId.value,
      eventType.value,
      sourceId,
    ),
  };
  const parsed = ExposureEventSchema.safeParse(candidate);

  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: "VALIDATION_ERROR",
        message: "Exposure event failed schema validation",
        details: {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.map(String),
            message: issue.message,
          })),
        },
      },
    };
  }

  return { ok: true, value: parsed.data };
}

export function toTinybirdRow(event: ExposureEvent, payload: Payload): Record<string, unknown> {
  return {
    dedup_key: event.dedupKey,
    app_id: event.appId,
    environment_id: event.environmentId,
    experiment_id: event.experimentId,
    run_id: event.runId,
    id_type: event.idType,
    targeting_key_hash: event.targetingKeyHash,
    variant: event.variantName,
    type: event.type,
    event_id: event.eventId,
    counterfactual: event.counterfactual ? 1 : 0,
    source_id: event.sourceId,
    client_timestamp: event.clientTimestamp,
    server_received_at: event.serverReceivedAt,
    ingest_ts: event.ingestTs,
    activation_ts: event.type === "activation" ? event.serverReceivedAt : null,
    is_holdover: payload.isHoldover === true ? 1 : 0,
    sdk_version: stringValue(payload.sdkVersion),
  };
}

export function tinybirdDelivery(env: Env): Outcome<TinybirdDelivery> {
  const token = env.TINYBIRD_INGEST_TOKEN;
  if (!token) {
    return { ok: false, error: serviceUnavailable("Tinybird ingest token is unavailable") };
  }

  const url = new URL("/v0/events", env.TINYBIRD_API_URL ?? "https://api.tinybird.co");
  url.searchParams.set("name", rawEventsDatasource);
  return { ok: true, value: { url: url.toString(), token } };
}

export async function appendRawEvent(row: Record<string, unknown>, delivery: TinybirdDelivery) {
  const response = await fetch(delivery.url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${delivery.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(row),
  });

  if (!response.ok) {
    throw new Error(`Tinybird append failed with HTTP ${response.status}`);
  }
}

async function exposureDedupKey(
  payload: Payload,
  appId: string,
  runScope: RunScope,
  eventId: string,
  type: string,
  sourceId: string,
): Promise<string> {
  const experimentId = stringValue(payload.experimentId) ?? "";
  const targetingKeyHash = stringValue(payload.targetingKeyHash) ?? "";
  const material = [
    type,
    appId,
    experimentId,
    runScope.runId,
    runScope.idType,
    targetingKeyHash,
    sourceId,
    eventId,
  ].join(":");
  return `sha256:${await sha256Hex(material)}`;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

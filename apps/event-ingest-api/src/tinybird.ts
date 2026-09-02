import { type ErrorResponse, type ExposureEvent, ExposureEventSchema } from "@splitch/contracts";
import { serviceUnavailable } from "./errors";
import { claimEvaluationUsageEventId } from "./evaluation-usage-replay";
import type { EvaluationUsageReplayWindow } from "./evaluation-usage-replay-window";
import { stringField, stringValue } from "./payload";
import type { CredentialScope, Env, Outcome, Payload, RunScope, TinybirdDelivery } from "./types";

const rawEventsDatasource = "raw_events";
export interface EvaluationUsageEvent {
  readonly eventId: string;
  readonly organizationId: string;
  readonly appId: string;
  readonly identityVersion: string;
  readonly environmentId: string;
  readonly flagKey: string;
  readonly sdkRuntime: string;
  readonly evaluationCount: number;
  readonly isBatch: boolean;
  readonly isCached: boolean;
  readonly hasExposure: boolean;
  readonly serverReceivedAt: string;
}

export type EvaluationUsageEventInput = Omit<EvaluationUsageEvent, "eventId"> & {
  readonly idempotencyKey: string;
};

export async function exposureEvent(
  payload: Payload,
  scope: CredentialScope,
  runScope: RunScope,
  env: Env,
): Promise<Outcome<ExposureEvent>> {
  const now = new Date(Date.now()).toISOString();
  const eventId = stringField(payload, "eventId");
  const eventType = stringField(payload, "type");
  const sourceId = stringValue(payload.sourceId) ?? env.SPLITCH_SOURCE_ID;
  if (!eventId.ok) return eventId;
  if (!eventType.ok) return eventType;
  if (!sourceId && env.SPLITCH_PLATFORM_TARGET !== "local") {
    return { ok: false, error: serviceUnavailable("Exposure source identity is unavailable") };
  }

  const candidate = {
    ...payload,
    appId: scope.appId,
    environmentId: scope.environmentId,
    runId: runScope.runId,
    idType: runScope.idType,
    sourceId: sourceId ?? "local",
    exposureAt: now,
    serverReceivedAt: now,
    dedupKey: await exposureDedupKey(
      payload,
      scope.appId,
      runScope,
      eventId.value,
      eventType.value,
      sourceId ?? "local",
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
    entity_family_hash: event.entityFamilyHash,
    variant: event.variantName ?? null,
    type: event.type,
    event_id: event.eventId,
    counterfactual: event.counterfactual ? 1 : 0,
    source_id: event.sourceId,
    client_timestamp: event.clientTimestamp ?? null,
    exposure_at: event.exposureAt,
    server_received_at: event.serverReceivedAt,
    activation_ts: event.type === "activation" ? event.serverReceivedAt : null,
    is_holdover: payload.isHoldover === true ? 1 : 0,
    sdk_version: stringValue(payload.sdkVersion),
  };
}

export async function evaluationUsageEvent(
  payload: Payload,
  scope: CredentialScope & { organizationId: string },
  replayWindow: EvaluationUsageReplayWindow | undefined,
): Promise<Outcome<EvaluationUsageEvent>> {
  const usage = evaluationUsagePayload(payload, scope);
  if (!usage.ok) return usage;

  if (replayWindow === undefined) {
    return {
      ok: false,
      error: serviceUnavailable("Evaluation usage replay window is unavailable"),
    };
  }
  let eventId: string;
  try {
    eventId = await claimEvaluationUsageEventId(
      scope,
      usage.value.idempotencyKey,
      replayWindow,
      usage.value.isCached ? "cached" : "remote",
    );
  } catch {
    return {
      ok: false,
      error: serviceUnavailable("Evaluation usage replay window is unavailable"),
    };
  }
  return { ok: true, value: { eventId, ...usage.value } };
}

export function evaluationUsagePayload(
  payload: Payload,
  scope: CredentialScope & { organizationId: string },
): Outcome<EvaluationUsageEventInput> {
  const dimensions = usageDimensions(payload);
  if (!dimensions.ok) return dimensions;
  const evaluation = evaluationUsageValues(payload);
  if (!evaluation.ok) return evaluation;
  const serverReceivedAt = new Date(Date.now()).toISOString();
  return {
    ok: true,
    value: {
      idempotencyKey: dimensions.value.idempotencyKey,
      organizationId: scope.organizationId,
      appId: scope.appId,
      identityVersion: dimensions.value.identityVersion,
      environmentId: scope.environmentId,
      flagKey: dimensions.value.flagKey,
      sdkRuntime: dimensions.value.sdkRuntime,
      ...evaluation.value,
      serverReceivedAt,
    },
  };
}

function usageDimensions(payload: Payload): Outcome<{
  idempotencyKey: string;
  identityVersion: string;
  flagKey: string;
  sdkRuntime: string;
}> {
  const idempotencyKey = stringField(payload, "idempotencyKey");
  const identityVersion = stringField(payload, "identityVersion");
  const flagKey = stringField(payload, "flagKey");
  const sdkRuntime = stringField(payload, "sdkRuntime");
  if (!idempotencyKey.ok) return idempotencyKey;
  if (!identityVersion.ok) return identityVersion;
  if (!flagKey.ok) return flagKey;
  if (!sdkRuntime.ok) return sdkRuntime;
  if (idempotencyKey.value.length > 255) {
    return { ok: false, error: invalidEvaluationUsageField("idempotencyKey") };
  }
  if (flagKey.value.length > 255 || sdkRuntime.value.length > 64) {
    return { ok: false, error: invalidEvaluationUsageField("usage dimensions") };
  }
  return {
    ok: true,
    value: {
      idempotencyKey: idempotencyKey.value,
      identityVersion: identityVersion.value,
      flagKey: flagKey.value,
      sdkRuntime: sdkRuntime.value,
    },
  };
}

function evaluationUsageValues(
  payload: Payload,
): Outcome<{ evaluationCount: number; isBatch: boolean; isCached: boolean; hasExposure: boolean }> {
  const { evaluationCount, isBatch, isCached, hasExposure } = payload;
  if (
    typeof evaluationCount !== "number" ||
    !Number.isInteger(evaluationCount) ||
    evaluationCount < 0 ||
    evaluationCount > 4_294_967_295
  ) {
    return { ok: false, error: invalidEvaluationUsageField("evaluationCount") };
  }
  if (
    typeof isBatch !== "boolean" ||
    typeof isCached !== "boolean" ||
    typeof hasExposure !== "boolean"
  ) {
    return { ok: false, error: invalidEvaluationUsageField("evaluation dimensions") };
  }
  if ((isCached && evaluationCount !== 0) || (!isCached && evaluationCount === 0)) {
    return { ok: false, error: invalidEvaluationUsageField("evaluationCount") };
  }
  return { ok: true, value: { evaluationCount, isBatch, isCached, hasExposure } };
}

export function toEvaluationUsageTinybirdRow(event: EvaluationUsageEvent): Record<string, unknown> {
  return {
    dedup_key: event.eventId,
    event_id: event.eventId,
    organization_id: event.organizationId,
    app_id: event.appId,
    identity_version: event.identityVersion,
    environment_id: event.environmentId,
    flag_key: event.flagKey,
    sdk_runtime: event.sdkRuntime,
    server_received_at: event.serverReceivedAt,
    evaluation_count: event.evaluationCount,
    is_batch: event.isBatch ? 1 : 0,
    is_cached: event.isCached ? 1 : 0,
    has_exposure: event.hasExposure ? 1 : 0,
  };
}

export function tinybirdDelivery(
  env: Env,
  datasource = rawEventsDatasource,
): Outcome<TinybirdDelivery> {
  const token = env.TINYBIRD_INGEST_TOKEN;
  if (!token) {
    return { ok: false, error: serviceUnavailable("Tinybird ingest token is unavailable") };
  }

  const apiUrl = env.TINYBIRD_API_URL;
  if (!apiUrl) {
    return { ok: false, error: serviceUnavailable("Tinybird API URL is unavailable") };
  }

  const url = new URL("/v0/events", apiUrl);
  url.searchParams.set("name", datasource);
  return { ok: true, value: { url: url.toString(), token } };
}

function invalidEvaluationUsageField(field: string): ErrorResponse {
  return {
    code: "VALIDATION_ERROR",
    message: `${field} is invalid`,
    details: { issues: [{ path: ["body", field], message: "invalid value" }] },
  };
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

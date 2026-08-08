import {
  EventDefinitionHotConfigSchema,
  eventDefinitionConfigKey,
  kvEnvelope,
  MetricEventTrackRequestSchema,
} from "@splitch/contracts";
import type { MetricEventCredentialScope } from "./client-key-auth";
import { renderError, serviceUnavailable } from "./errors";
import { claimMetricEvent } from "./metric-event-outbox";
import { checkMetricEventRateLimit } from "./metric-event-rate-limit";
import { validateMetricEvent } from "./metric-event-validation";
import type { Env } from "./types";

const MAX_BODY_BYTES = 32_768;
const hotConfigEnvelope = kvEnvelope(EventDefinitionHotConfigSchema);

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the contract requires ordered side-effect-free guards before the claim boundary
export async function handleAuthorizedMetricEvent(
  request: Request,
  env: Env,
  credential: MetricEventCredentialScope,
): Promise<Response> {
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    return renderError(validation("Metric Event body exceeds 32768 bytes", []));
  }
  let candidate: unknown;
  try {
    candidate = JSON.parse(text);
  } catch {
    return renderError(validation("Metric Event body must be JSON", []));
  }
  const parsed = MetricEventTrackRequestSchema.safeParse(candidate);
  if (!parsed.success) {
    return renderError({
      code: "VALIDATION_ERROR",
      message: "Metric Event request is invalid",
      details: {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.map(String),
          message: issue.message,
        })),
      },
    });
  }

  try {
    const rate = await checkMetricEventRateLimit(
      env.METRIC_EVENT_RATE_LIMIT,
      credential.credentialHash,
      credential.rateLimitRps,
    );
    if (rate.limited) {
      return renderError({
        code: "RATE_LIMITED",
        message: "Client Key rate limit exceeded",
        details: { retryAfterMs: rate.retryAfterMs },
      });
    }
  } catch {
    return renderError(serviceUnavailable("Metric Event rate limiter is unavailable"));
  }

  const targetingKeyHash = await computeTargetingKeyHash(
    env,
    parsed.data.idType,
    parsed.data.targetingKey,
  );
  const fingerprint = await sha256(
    canonicalJson({
      eventName: parsed.data.eventName,
      idType: parsed.data.idType,
      targetingKeyHash,
      fields: parsed.data.fields,
      dimensions: parsed.data.dimensions,
    }),
  );
  const dedupKey = await sha256(
    `metric:${credential.appId}:${credential.environmentId}:${parsed.data.eventId}`,
  );

  const hot = await loadDefinition(env, credential.appId, parsed.data.eventName);
  if (hot instanceof Response) return hot;
  const issues = validateMetricEvent(parsed.data, hot.version);
  if (issues.length > 0) {
    if (issues.length === 1 && issues[0]?.path[0] === "idType") {
      return renderError({
        code: "ENTITY_TYPE_MISMATCH",
        message: "Metric Event Entity type does not match the Event Definition Version",
        details: {
          expectedIdType: hot.version.entityType,
          receivedIdType: parsed.data.idType,
          eventDefinitionId: hot.eventDefinition.id,
        },
      });
    }
    return renderError({
      code: "EVENT_SCHEMA_MISMATCH",
      message: "Metric Event does not match the Event Definition Version",
      details: {
        eventName: parsed.data.eventName,
        eventDefinitionVersionId: hot.version.id,
        issues,
      },
    });
  }

  const now = new Date().toISOString();
  const row = {
    dedup_key: dedupKey,
    event_id: parsed.data.eventId,
    app_id: credential.appId,
    environment_id: credential.environmentId,
    event_definition_id: hot.eventDefinition.id,
    event_definition_version_id: hot.version.id,
    event_name: parsed.data.eventName,
    id_type: parsed.data.idType,
    targeting_key_hash: targetingKeyHash,
    fields: canonicalJson(parsed.data.fields),
    dimensions: canonicalJson(parsed.data.dimensions),
    server_received_at: now,
  };
  try {
    const claim = await claimMetricEvent(env.METRIC_EVENT_OUTBOX, dedupKey, {
      fingerprint,
      eventDefinitionId: hot.eventDefinition.id,
      eventDefinitionVersionId: hot.version.id,
      row,
    });
    if (claim.outcome === "conflict") {
      return renderError({
        code: "EVENT_ID_CONFLICT",
        message: "eventId was already used for different Metric Event content",
        details: { eventId: parsed.data.eventId },
      });
    }
    return Response.json(
      {
        accepted: true,
        duplicate: claim.outcome === "duplicate",
        eventId: parsed.data.eventId,
        eventDefinitionId: claim.eventDefinitionId,
        eventDefinitionVersionId: claim.eventDefinitionVersionId,
      },
      { status: 202 },
    );
  } catch {
    return renderError(serviceUnavailable("Metric Event outbox is unavailable"));
  }
}

async function loadDefinition(env: Env, appId: string, eventName: string) {
  if (!env.CONFIG_STORE)
    return renderError(serviceUnavailable("CONFIG_STORE binding is unavailable"));
  const raw = await env.CONFIG_STORE.get(eventDefinitionConfigKey(appId, eventName), "text");
  if (raw === null)
    return renderError({
      code: "EVENT_DEFINITION_NOT_FOUND",
      message: "Metric Event Definition not found",
      details: {},
    });
  try {
    const hot = hotConfigEnvelope.parse(JSON.parse(raw)).data;
    if (hot.eventDefinition.family !== "metric") {
      return renderError({
        code: "EVENT_DEFINITION_NOT_FOUND",
        message: "Metric Event Definition not found",
        details: {},
      });
    }
    return hot;
  } catch {
    return renderError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Event Definition config is invalid",
      details: {},
    });
  }
}

function localSalt(target: string | undefined): string {
  if (target === undefined || target === "local" || target === "pr-ci")
    return "splitch-local-evaluation-salt";
  throw new Error("EVALUATION_PRIVACY_SALT is required outside local targets");
}

async function computeTargetingKeyHash(
  env: Env,
  idType: string,
  targetingKey: string,
): Promise<string> {
  const secret = env.EVALUATION_PRIVACY_SALT ?? localSalt(env.SPLITCH_PLATFORM_TARGET);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${idType}:${targetingKey}`),
  );
  return `v1:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function validation(message: string, path: string[]) {
  return { code: "VALIDATION_ERROR" as const, message, details: { issues: [{ path, message }] } };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

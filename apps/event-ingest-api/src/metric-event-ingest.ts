import {
  EventDefinitionHotConfigSchema,
  eventDefinitionConfigKey,
  isLocalPlatformTarget,
  kvEnvelope,
  MetricEventTrackRequestSchema,
  requirePlatformTarget,
} from "@splitch/contracts";
import {
  computeTargetingKeyHash,
  makeDerivedSaltStore,
  resolvePrivacyRootSecret,
} from "@splitch/privacy";
import type { MetricEventCredentialScope } from "./client-key-auth";
import { renderError, serviceUnavailable } from "./errors";
import {
  admitAndClaimMetricEvent,
  canonicalJson,
  replayExistingMetricEvent,
  schemaMismatch,
} from "./metric-event-admission";
import { checkMetricEventRateLimit } from "./metric-event-rate-limit";
import type { Env } from "./types";

const MAX_BODY_BYTES = 32_768;
const hotConfigEnvelope = kvEnvelope(EventDefinitionHotConfigSchema);

export async function handleAuthorizedMetricEvent(
  request: Request,
  env: Env,
  credential: MetricEventCredentialScope,
): Promise<Response> {
  const parsed = await parseMetricEventRequest(request);
  if (parsed instanceof Response) return parsed;
  const limited = await enforceCredentialRateLimit(env, credential);
  if (limited) return limited;

  const targetingKeyHash = await computeTargetingKeyHash(makeMetricEventSaltStore(env), {
    appId: credential.appId,
    idType: parsed.idType,
    targetingKey: parsed.targetingKey,
  });
  const fingerprint = await sha256(
    canonicalJson({
      eventName: parsed.eventName,
      idType: parsed.idType,
      targetingKeyHash,
      fields: parsed.fields,
      dimensions: parsed.dimensions,
    }),
  );
  const dedupKey = await sha256(
    `metric:${credential.appId}:${credential.environmentId}:${parsed.eventId}`,
  );
  const replay = await replayExistingMetricEvent(env, parsed.eventId, dedupKey, fingerprint);
  if (replay) return replay;

  const hot = await loadDefinition(env, credential.appId, parsed.eventName);
  if (hot instanceof Response) return hot;
  const mismatch = schemaMismatch(parsed, hot);
  if (mismatch) return mismatch;

  return admitAndClaimMetricEvent(env, credential, parsed, {
    targetingKeyHash,
    fingerprint,
    dedupKey,
    eventDefinitionId: hot.eventDefinition.id,
    eventDefinitionVersionId: hot.version.id,
  });
}

async function parseMetricEventRequest(request: Request) {
  const text = await readMetricEventBody(request);
  if (text === null) {
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
  return parsed.data;
}

async function enforceCredentialRateLimit(
  env: Env,
  credential: MetricEventCredentialScope,
): Promise<Response | null> {
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
    return null;
  } catch {
    return renderError(serviceUnavailable("Metric Event rate limiter is unavailable"));
  }
}

async function readMetricEventBody(request: Request): Promise<string | null> {
  if (bodyTooLargeFromHeader(request.headers.get("content-length"))) return null;
  if (request.body === null) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (next.value.byteLength > MAX_BODY_BYTES - byteLength) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(next.value);
      byteLength += next.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function bodyTooLargeFromHeader(contentLength: string | null): boolean {
  return /^\d+$/u.test(contentLength ?? "") && Number(contentLength) > MAX_BODY_BYTES;
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

export function makeMetricEventSaltStore(env: Env) {
  const target = requirePlatformTarget(env.SPLITCH_PLATFORM_TARGET);
  return makeDerivedSaltStore({
    rootSecret: resolvePrivacyRootSecret({
      configuredSalt: env.EVALUATION_PRIVACY_SALT,
      localFixtureAllowed: isLocalPlatformTarget(target),
    }),
  });
}

function validation(message: string, path: string[]) {
  return { code: "VALIDATION_ERROR" as const, message, details: { issues: [{ path, message }] } };
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

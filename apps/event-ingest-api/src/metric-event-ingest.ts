import {
  EventDefinitionHotConfigSchema,
  eventDefinitionConfigKey,
  kvEnvelope,
  type MetricEventTrackRequest,
  MetricEventTrackRequestSchema,
} from "@splitch/contracts";
import { canonicalizeAnalysisEntityHash, resolveEntityPrivacyIdentity } from "@splitch/privacy";
import type { MetricEventCredentialScope } from "./client-key-auth";
import { renderError, serviceUnavailable } from "./errors";
import {
  type EventDefinitionMismatchSink,
  recordEventDefinitionMismatch,
} from "./event-definition-mismatch-diagnostics";
import {
  admitAndClaimMetricEvent,
  canonicalJson,
  replayExistingMetricEvent,
  schemaMismatch,
} from "./metric-event-admission";
import { checkMetricEventRateLimit } from "./metric-event-rate-limit";
import { makeMetricEventSaltStore } from "./metric-event-salt-store";
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

  const saltStore = makeMetricEventSaltStore(env);
  const identity = await resolveEntityPrivacyIdentity(saltStore, {
    appId: credential.appId,
    idType: parsed.idType,
    targetingKey: parsed.targetingKey,
  });
  const targetingKeyHash = canonicalizeAnalysisEntityHash(identity.targetingKeyHashes);
  const fingerprint = await metricEventPayloadFingerprint({
    eventName: parsed.eventName,
    idType: parsed.idType,
    targetingKeyHash,
    fields: parsed.fields,
    dimensions: parsed.dimensions,
  });
  const retainedFingerprints = await retainedMetricEventFingerprints(identity.targetingKeyHashes, {
    eventName: parsed.eventName,
    idType: parsed.idType,
    targetingKeyHash,
    fields: parsed.fields,
    dimensions: parsed.dimensions,
  });
  const dedupKey = await metricEventDedupKey(
    credential.appId,
    credential.environmentId,
    parsed.eventId,
  );
  const disclosure = credential.credentialKind === "api_key" ? "trusted" : "public";
  const replay = await replayExistingMetricEvent(
    env,
    parsed.eventId,
    dedupKey,
    fingerprint,
    retainedFingerprints,
    disclosure,
  );
  if (replay) return replay;

  const hot = await loadDefinition(env, credential, parsed, disclosure);
  if (hot instanceof Response) return hot;
  const mismatch = schemaMismatch(parsed, hot, disclosure);
  if (mismatch) return mismatch;

  return admitAndClaimMetricEvent(env, credential, parsed, {
    targetingKeyHash,
    entityFamilyHash: identity.entityFamilyHash,
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

async function loadDefinition(
  env: Env,
  credential: MetricEventCredentialScope,
  parsed: MetricEventTrackRequest,
  disclosure: "public" | "trusted",
  sink: EventDefinitionMismatchSink = recordEventDefinitionMismatch,
) {
  if (!env.CONFIG_STORE)
    return renderError(serviceUnavailable("CONFIG_STORE binding is unavailable"));
  const raw = await env.CONFIG_STORE.get(
    eventDefinitionConfigKey(credential.appId, parsed.eventName),
    "text",
  );
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
    if (
      hot.eventDefinition.state !== "published" ||
      hot.eventDefinition.currentPublishedVersionId === null
    ) {
      sink({
        eventName: parsed.eventName,
        eventDefinitionId: hot.eventDefinition.id,
        eventDefinitionVersionId: hot.version.id,
        eventDefinition: hot.eventDefinition,
        version: hot.version,
        originalIssues: [
          {
            path: [],
            message: `Event Definition ${hot.eventDefinition.id} is ${hot.eventDefinition.state} with currentPublishedVersionId ${hot.eventDefinition.currentPublishedVersionId}`,
          },
        ],
      });
      return renderError({
        code: "EVENT_DEFINITION_UNPUBLISHED",
        message: "Metric Event Definition Version is not published",
        details:
          disclosure === "trusted"
            ? { eventDefinitionId: hot.eventDefinition.id, eventName: parsed.eventName }
            : { eventName: parsed.eventName },
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

export async function metricEventDedupKey(
  appId: string,
  environmentId: string,
  eventId: string,
): Promise<string> {
  return sha256(`metric:${appId}:${environmentId}:${eventId}`);
}

export async function metricEventPayloadFingerprint(input: {
  eventName: string;
  idType: string;
  targetingKeyHash: string;
  fields: unknown;
  dimensions: unknown;
}): Promise<string> {
  return sha256(
    canonicalJson({
      eventName: input.eventName,
      idType: input.idType,
      targetingKeyHash: input.targetingKeyHash,
      fields: input.fields,
      dimensions: input.dimensions,
    }),
  );
}

async function retainedMetricEventFingerprints(
  hashes: readonly string[],
  input: {
    eventName: string;
    idType: string;
    targetingKeyHash: string;
    fields: unknown;
    dimensions: unknown;
  },
): Promise<readonly string[]> {
  const fingerprints = [];
  for (const hash of hashes) {
    if (hash === input.targetingKeyHash) continue;
    fingerprints.push(
      await metricEventPayloadFingerprint({
        eventName: input.eventName,
        idType: input.idType,
        targetingKeyHash: hash,
        fields: input.fields,
        dimensions: input.dimensions,
      }),
    );
  }
  return fingerprints;
}

function validation(message: string, path: string[]) {
  return { code: "VALIDATION_ERROR" as const, message, details: { issues: [{ path, message }] } };
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

import {
  EventDefinitionHotConfigSchema,
  eventDefinitionConfigKey,
  kvEnvelope,
  type MetricEventTrackRequest,
  MetricEventTrackRequestSchema,
} from "@splitch/contracts";
import type { MetricEventCredentialScope } from "./client-key-auth";
import { renderError, serviceUnavailable } from "./errors";
import {
  type EventDefinitionMismatchSink,
  recordEventDefinitionMismatch,
} from "./event-definition-mismatch-diagnostics";
import {
  createIngestPhaseTiming,
  type IngestPhaseTiming,
  ingestTimingOutcomeFor,
} from "./ingest-phase-timing";
import { activationRows } from "./metric-event-activation";
import {
  admitAndClaimMetricEvent,
  replayExistingMetricEvent,
  schemaMismatch,
} from "./metric-event-admission";
import { resolveMetricEventIdentityMaterial } from "./metric-event-identity";
import { checkMetricEventRateLimit } from "./metric-event-rate-limit";
import type { Env } from "./types";

const MAX_BODY_BYTES = 32_768;
const hotConfigEnvelope = kvEnvelope(EventDefinitionHotConfigSchema);

type MetricEventParseResult =
  | { readonly ok: true; readonly value: MetricEventTrackRequest; readonly serializedBytes: number }
  | { readonly ok: false; readonly response: Response; readonly serializedBytes: number | null };

export async function handleAuthorizedMetricEvent(
  request: Request,
  env: Env,
  credential: MetricEventCredentialScope,
  timing: IngestPhaseTiming = createIngestPhaseTiming(env, {
    route: "sdk_metric_event",
    stream: "metric_events",
  }),
  activate = false,
): Promise<Response> {
  const parsedResult = await timing.measure("parse", () => parseMetricEventRequest(request));
  if (!parsedResult.ok) {
    return timedMetricResponse(timing, parsedResult.response, parsedResult.serializedBytes);
  }
  const { value: parsed, serializedBytes } = parsedResult;
  const limited = await timing.measure("rateLimit", () =>
    enforceCredentialRateLimit(env, credential),
  );
  if (limited) return timedMetricResponse(timing, limited, serializedBytes);

  const identityMaterial = await timing.measure("identity", () =>
    resolveMetricEventIdentityMaterial(env, credential, parsed),
  );
  const { identity, targetingKeyHash, fingerprint, retainedFingerprints, dedupKey } =
    identityMaterial;
  const disclosure = credential.credentialKind === "api_key" ? "trusted" : "public";
  const replay = await timing.measure("replay", () =>
    replayExistingMetricEvent(
      env,
      parsed.eventId,
      dedupKey,
      fingerprint,
      retainedFingerprints,
      disclosure,
      activate,
    ),
  );
  if (replay) return timedMetricResponse(timing, replay, serializedBytes);

  const hot = await timing.measure("config", () =>
    loadDefinition(env, credential, parsed, disclosure),
  );
  if (hot instanceof Response) return timedMetricResponse(timing, hot, serializedBytes);
  const mismatch = schemaMismatch(parsed, hot, disclosure);
  if (mismatch) return timedMetricResponse(timing, mismatch, serializedBytes);

  let matchedActivationRows: Record<string, unknown>[] = [];
  if (activate) {
    try {
      matchedActivationRows = await timing.measure("activationConfig", () =>
        activationRows(
          env,
          credential,
          parsed,
          {
            targetingKeyHash,
            targetingKeyHashes: identity.targetingKeyHashes,
            entityFamilyHash: identity.entityFamilyHash,
          },
          hot.eventDefinition.id,
        ),
      );
    } catch {
      return timedMetricResponse(
        timing,
        renderError(serviceUnavailable("Activation configuration is unavailable")),
        serializedBytes,
      );
    }
  }
  const response = await timing.measure("admissionQueue", () =>
    admitAndClaimMetricEvent(
      env,
      credential,
      parsed,
      {
        targetingKeyHash,
        entityFamilyHash: identity.entityFamilyHash,
        fingerprint,
        dedupKey,
        eventDefinitionId: hot.eventDefinition.id,
        eventDefinitionVersionId: hot.version.id,
      },
      matchedActivationRows,
      activate,
    ),
  );
  return timedMetricResponse(timing, response, serializedBytes);
}

function timedMetricResponse(
  timing: IngestPhaseTiming,
  response: Response,
  serializedBytes: number | null,
): Response {
  timing.emit(ingestTimingOutcomeFor(response), { serializedBytes });
  return response;
}

async function parseMetricEventRequest(request: Request): Promise<MetricEventParseResult> {
  const body = await readMetricEventBody(request);
  if (body === null) {
    return {
      ok: false,
      response: renderError(validation("Metric Event body exceeds 32768 bytes", [])),
      serializedBytes: null,
    };
  }
  let candidate: unknown;
  try {
    candidate = JSON.parse(body.text);
  } catch {
    return {
      ok: false,
      response: renderError(validation("Metric Event body must be JSON", [])),
      serializedBytes: body.serializedBytes,
    };
  }
  const parsed = MetricEventTrackRequestSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      response: renderError({
        code: "VALIDATION_ERROR",
        message: "Metric Event request is invalid",
        details: {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.map(String),
            message: issue.message,
          })),
        },
      }),
      serializedBytes: body.serializedBytes,
    };
  }
  return { ok: true, value: parsed.data, serializedBytes: body.serializedBytes };
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

async function readMetricEventBody(
  request: Request,
): Promise<{ readonly text: string; readonly serializedBytes: number } | null> {
  if (bodyTooLargeFromHeader(request.headers.get("content-length"))) return null;
  if (request.body === null) return { text: "", serializedBytes: 0 };

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
  return { text: new TextDecoder().decode(bytes), serializedBytes: byteLength };
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

function validation(message: string, path: string[]) {
  return { code: "VALIDATION_ERROR" as const, message, details: { issues: [{ path, message }] } };
}

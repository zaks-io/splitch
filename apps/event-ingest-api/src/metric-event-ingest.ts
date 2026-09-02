import {
  EventDefinitionHotConfigSchema,
  eventDefinitionConfigKey,
  kvEnvelope,
  type MetricEventTrackRequest,
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
import { ActivationResolutionError, activationRows } from "./metric-event-activation";
import {
  admitAndClaimMetricEvent,
  replayExistingMetricEvent,
  schemaMismatch,
} from "./metric-event-admission";
import { parseMetricEventRequest } from "./metric-event-body";
import { resolveMetricEventIdentityMaterial } from "./metric-event-identity";
import { checkMetricEventRateLimit } from "./metric-event-rate-limit";
import type { Env } from "./types";

const hotConfigEnvelope = kvEnvelope(EventDefinitionHotConfigSchema);

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
    } catch (cause) {
      return timedMetricResponse(
        timing,
        activationFailure(cause, parsed, hot.eventDefinition.id),
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

/**
 * Six distinct resolution failures used to collapse into one opaque 503 with no
 * log line, which made a broken Activation indistinguishable from an unpublished
 * config blob. The response now names the step that failed; the ids behind it are
 * operator-only, so they go to the log untruncated and never to the body.
 */
function activationFailure(
  cause: unknown,
  event: MetricEventTrackRequest,
  eventDefinitionId: string,
): Response {
  const resolution = cause instanceof ActivationResolutionError ? cause : null;
  console.error(
    "event-ingest-api activation resolution failed",
    JSON.stringify({
      eventName: event.eventName,
      eventId: event.eventId,
      idType: event.idType,
      eventDefinitionId,
      message: cause instanceof Error ? cause.message : String(cause),
      detail: resolution?.detail ?? null,
      stack: cause instanceof Error ? cause.stack : null,
    }),
  );
  return renderError(
    serviceUnavailable(resolution?.message ?? "Activation configuration is unavailable"),
  );
}

function timedMetricResponse(
  timing: IngestPhaseTiming,
  response: Response,
  serializedBytes: number | null,
): Response {
  timing.emit(ingestTimingOutcomeFor(response), { serializedBytes });
  return response;
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

import {
  EventDefinitionHotConfigSchema,
  eventDefinitionConfigKey,
  kvEnvelope,
  type MetricEventTrackRequest,
} from "@splitch/contracts";
import type { MetricEventCredentialScope } from "./client-key-auth";
import { activationNotAvailable, renderError, serviceUnavailable } from "./errors";
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
        activationFailure(cause, parsed, hot.eventDefinition.id, disclosure),
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
 * Eight distinct resolution failures used to collapse into one opaque 503 with no
 * log line, which made a broken Activation indistinguishable from an unpublished
 * config blob. The step that failed is named only for an API Key: to a public
 * Client Key these messages would answer "is this Entity enrolled?" and "which
 * Event Definitions gate an Activation?" one request at a time. Operators get the
 * full cause plus ids from the log, which is where the ids only ever go.
 */
function activationFailure(
  cause: unknown,
  event: MetricEventTrackRequest,
  eventDefinitionId: string,
  disclosure: "trusted" | "public",
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
  return renderError(activationResolutionError(resolution, disclosure));
}

/**
 * `not_exposed` is the one cause that splits on disclosure rather than just
 * losing its prose. The Exposure for a first-generation Entity can still be in
 * flight when its Activation arrives, so an API Key needs a machine-readable
 * "try again" and gets 503 + `retryAfterMs`, not a 409 it can only tell apart
 * from a permanent misconfiguration by reading English. A Client Key keeps the
 * 409 the two permanent causes render: `transient` is public-safe because those
 * causes are infrastructure-wide, but a 503 that fires exactly when THIS Entity
 * has no Exposure is an enrollment oracle (ADR-0018), one request at a time.
 */
function activationResolutionError(
  resolution: ActivationResolutionError | null,
  disclosure: "trusted" | "public",
) {
  if (disclosure === "trusted" && resolution?.resolution === "not_exposed") {
    return serviceUnavailable(resolution.message);
  }
  if (
    resolution?.resolution === "not_available" ||
    resolution?.resolution === "not_exposed" ||
    (disclosure === "public" && resolution?.resolution === "unpublished")
  ) {
    return activationNotAvailable(
      disclosure === "trusted" && resolution
        ? resolution.message
        : "Activation is not available for this Metric Event",
    );
  }
  return serviceUnavailable(
    disclosure === "trusted" && resolution
      ? resolution.message
      : "Activation configuration is unavailable",
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

import type { EventDefinition, MetricEventTrackRequest } from "@splitch/contracts";
import type { MetricEventCredentialScope } from "./client-key-auth";
import { renderError, serviceUnavailable } from "./errors";
import {
  type EventDefinitionMismatchSink,
  recordEventDefinitionMismatch,
} from "./event-definition-mismatch-diagnostics";
import { rejectIngestAdmission } from "./ingest-admission";
import { claimMetricEvent, lookupMetricEvent } from "./metric-event-outbox";
import { validateMetricEvent } from "./metric-event-validation";
import { publicValidationIssues } from "./public-schema-mismatch";
import type { Env } from "./types";

export async function replayExistingMetricEvent(
  env: Env,
  eventId: string,
  dedupKey: string,
  fingerprint: string,
  disclosure: "public" | "trusted" = "public",
): Promise<Response | null> {
  try {
    const existing = await lookupMetricEvent(env.METRIC_EVENT_OUTBOX, dedupKey);
    if (existing === null) return null;
    if (existing.fingerprint !== fingerprint) return eventIdConflict(eventId);
    const replay = await claimMetricEvent(env.METRIC_EVENT_OUTBOX, dedupKey, {
      fingerprint,
      eventDefinitionId: existing.eventDefinitionId,
      eventDefinitionVersionId: existing.eventDefinitionVersionId,
      row: {},
    });
    return acceptedMetricEvent(eventId, replay, disclosure);
  } catch {
    return renderError(serviceUnavailable("Metric Event outbox is unavailable"));
  }
}

export async function admitAndClaimMetricEvent(
  env: Env,
  credential: MetricEventCredentialScope,
  parsed: MetricEventTrackRequest,
  identity: {
    targetingKeyHash: string;
    fingerprint: string;
    dedupKey: string;
    eventDefinitionId: string;
    eventDefinitionVersionId: string;
  },
): Promise<Response> {
  const row = {
    dedup_key: identity.dedupKey,
    event_id: parsed.eventId,
    app_id: credential.appId,
    environment_id: credential.environmentId,
    event_definition_id: identity.eventDefinitionId,
    event_definition_version_id: identity.eventDefinitionVersionId,
    event_name: parsed.eventName,
    id_type: parsed.idType,
    targeting_key_hash: identity.targetingKeyHash,
    fields: canonicalJson(parsed.fields),
    dimensions: canonicalJson(parsed.dimensions),
    server_received_at: new Date().toISOString(),
  };
  const denied = await chargeNewMetricEvent(env, credential, row);
  if (denied) return denied;
  try {
    const claim = await claimMetricEvent(env.METRIC_EVENT_OUTBOX, identity.dedupKey, {
      fingerprint: identity.fingerprint,
      eventDefinitionId: identity.eventDefinitionId,
      eventDefinitionVersionId: identity.eventDefinitionVersionId,
      row,
    });
    if (claim.outcome === "conflict") return eventIdConflict(parsed.eventId);
    return acceptedMetricEvent(
      parsed.eventId,
      claim,
      credential.credentialKind === "api_key" ? "trusted" : "public",
    );
  } catch {
    return renderError(serviceUnavailable("Metric Event outbox is unavailable"));
  }
}

export function schemaMismatch(
  parsed: MetricEventTrackRequest,
  hot: { eventDefinition: EventDefinition; version: Parameters<typeof validateMetricEvent>[1] },
  disclosure: "public" | "trusted" = "public",
  sink: EventDefinitionMismatchSink = recordEventDefinitionMismatch,
): Response | null {
  const issues = validateMetricEvent(parsed, hot.version);
  if (issues.length === 0) return null;
  sink({
    eventName: parsed.eventName,
    eventDefinitionId: hot.eventDefinition.id,
    eventDefinitionVersionId: hot.version.id,
    eventDefinition: hot.eventDefinition,
    version: hot.version,
    originalIssues: issues,
  });
  if (issues.length === 1 && issues[0]?.path[0] === "idType") {
    return renderError({
      code: "ENTITY_TYPE_MISMATCH",
      message: "Metric Event Entity type does not match the Event Definition Version",
      details:
        disclosure === "trusted"
          ? {
              expectedIdType: hot.version.entityType,
              receivedIdType: parsed.idType,
              eventDefinitionId: hot.eventDefinition.id,
            }
          : { receivedIdType: parsed.idType },
    });
  }
  return renderError({
    code: "EVENT_SCHEMA_MISMATCH",
    message: "Metric Event does not match the Event Definition Version",
    details: {
      eventName: parsed.eventName,
      ...(disclosure === "trusted" ? { eventDefinitionVersionId: hot.version.id } : {}),
      issues: disclosure === "trusted" ? issues : publicValidationIssues(issues, parsed),
    },
  });
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function chargeNewMetricEvent(
  env: Env,
  credential: MetricEventCredentialScope,
  row: Record<string, unknown>,
): Promise<Response | null> {
  return rejectIngestAdmission(
    env.INGEST_ADMISSION_GATE,
    {
      appId: credential.appId,
      environmentId: credential.environmentId,
      ingestStream: "metric_events",
    },
    [row],
    "Metric Event ingest admission capacity exceeded",
  );
}

function eventIdConflict(eventId: string): Response {
  return renderError({
    code: "EVENT_ID_CONFLICT",
    message: "eventId was already used for different Metric Event content",
    details: { eventId },
  });
}

function acceptedMetricEvent(
  eventId: string,
  claim: { eventDefinitionId: string; eventDefinitionVersionId: string; outcome: string },
  disclosure: "public" | "trusted",
): Response {
  return Response.json(
    {
      accepted: true,
      duplicate: claim.outcome === "duplicate",
      eventId,
      ...(disclosure === "trusted"
        ? {
            eventDefinitionId: claim.eventDefinitionId,
            eventDefinitionVersionId: claim.eventDefinitionVersionId,
          }
        : {}),
    },
    { status: 202 },
  );
}

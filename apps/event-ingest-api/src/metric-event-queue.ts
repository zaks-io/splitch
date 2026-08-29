import { requirePlatformTarget } from "@splitch/contracts";
import { deliverEntityIdentityRow } from "./entity-identity-row-delivery";
import { identityVersionForRow } from "./entity-metric-privacy";
import { makeMetricEventSaltStore } from "./metric-event-salt-store";
import { appendRawEvent, tinybirdDelivery } from "./tinybird";
import type { Env } from "./types";

type MetricEventRow = Record<string, unknown>;

/** Must equal `queues.consumers[].max_retries` in wrangler.jsonc; a test holds the two together. */
export const METRIC_EVENT_MAX_RETRIES = 7;

export async function handleMetricEventQueue(
  batch: MessageBatch<MetricEventRow>,
  env: Env,
): Promise<void> {
  requirePlatformTarget(env.SPLITCH_PLATFORM_TARGET);
  makeMetricEventSaltStore(env);
  const delivery = tinybirdDelivery(env, "metric_events");
  await Promise.all(batch.messages.map((message) => deliverMetricEvent(message, env, delivery)));
}

async function deliverMetricEvent(
  message: Message<MetricEventRow>,
  env: Env,
  delivery: ReturnType<typeof tinybirdDelivery>,
): Promise<void> {
  try {
    if (!delivery.ok) throw new Error(delivery.error.message);
    if (
      !env.ENTITY_METRIC_PRIVACY &&
      (env.SPLITCH_PLATFORM_TARGET === "local" || env.SPLITCH_PLATFORM_TARGET === "pr-ci")
    ) {
      await appendRawEvent(message.body, delivery.value);
    } else {
      await deliverEntityIdentityRow(
        env.ENTITY_METRIC_PRIVACY,
        identityVersionForRow(message.body),
        "metric_events",
        message.body,
        env.SPLITCH_PLATFORM_TARGET,
      );
    }
    message.ack();
  } catch (error) {
    logMetricEventFailure(message, error);
    message.retry();
  }
}

function logMetricEventFailure(message: Message<MetricEventRow>, error: unknown): void {
  const finalAttempt = message.attempts > METRIC_EVENT_MAX_RETRIES;
  console.error(
    finalAttempt
      ? "event-ingest-api Metric Event discarded after final delivery attempt"
      : "event-ingest-api Metric Event delivery failed",
    {
      queueMessageId: message.id,
      attempts: message.attempts,
      maxRetries: METRIC_EVENT_MAX_RETRIES,
      ...metricEventIdentity(message.body),
      errorMessage: error instanceof Error ? error.message : "non-error rejection",
    },
  );
}

/**
 * Every identifier on a Metric Event, log key to row column.
 *
 * After the final attempt Cloudflare deletes the message and the outbox has
 * already claimed the dedup key, so this log line is the only surviving record
 * of the event. `dedup_key` and `targeting_key_hash` are what scope the damage
 * and find the source; the payload columns (`fields`, `dimensions`) are the only
 * thing deliberately left out.
 */
const IDENTITY_COLUMNS = {
  appId: "app_id",
  environmentId: "environment_id",
  eventId: "event_id",
  dedupKey: "dedup_key",
  eventDefinitionId: "event_definition_id",
  eventDefinitionVersionId: "event_definition_version_id",
  eventName: "event_name",
  idType: "id_type",
  targetingKeyHash: "targeting_key_hash",
  serverReceivedAt: "server_received_at",
  ingestTs: "ingest_ts",
} as const;

function metricEventIdentity(row: MetricEventRow): Record<string, string> {
  return Object.fromEntries(
    Object.entries(IDENTITY_COLUMNS).map(([key, column]) => [key, identityValue(row[column])]),
  );
}

/**
 * A malformed row still has to identify itself, so nothing is ever omitted: a
 * value that is not a string is rendered, and one that is absent says so. An
 * omitted key would read as an event that never carried that identifier.
 */
function identityValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "<absent>";
  return JSON.stringify(value) ?? String(value);
}

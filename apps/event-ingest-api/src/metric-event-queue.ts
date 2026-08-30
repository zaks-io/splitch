import { requirePlatformTarget } from "@splitch/contracts";
import { deliverEntityIdentityRow } from "./entity-identity-row-delivery";
import { identityVersionForRow } from "./entity-metric-privacy";
import { makeMetricEventSaltStore } from "./metric-event-salt-store";
import { appendRawEvent, tinybirdDelivery } from "./tinybird";
import type { Env } from "./types";

type MetricEventRow = Record<string, unknown>;

/** Must equal `queues.consumers[].max_retries` in wrangler.jsonc; a test holds the two together. */
export const METRIC_EVENT_MAX_RETRIES = 7;

/**
 * Backoff floor and ceiling, in seconds. Doubling from 5 across the seven
 * configured retries spans 635 seconds, or just under twice that once jitter is
 * added, so a failing row gets a 10 to 21 minute tail: long enough to ride out a
 * Tinybird incident and short enough that a recovered pipeline drains promptly.
 * The doubling never reaches the ceiling. It is there so that no computed delay
 * can exceed the 86,400 Cloudflare accepts for a delayed message
 * (https://developers.cloudflare.com/queues/configuration/javascript-apis/).
 */
const RETRY_BASE_SECONDS = 5;
const RETRY_MAX_SECONDS = 43_200;

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
    message.retry({ delaySeconds: metricEventRetryDelaySeconds(message.attempts, message.id) });
  }
}

/**
 * How long to hold a failed Metric Event before the next attempt.
 *
 * An immediate retry re-runs the whole batch against the same unhealthy
 * Tinybird within milliseconds, so a rate limit or an outage burns all seven
 * attempts in about a second and the events are gone. The delay doubles per
 * attempt, and a per-message offset derived from the queue message id spreads a
 * batch that failed together across the interval instead of resending it as one
 * herd. The offset is a pure function of the id, so a given message's delay
 * still rises strictly with each attempt.
 *
 * `attempts` comes from the runtime, so a non-finite or out-of-range value is
 * clamped rather than propagated: a NaN delay would be rejected by Queues and
 * cost the message its retry.
 */
export function metricEventRetryDelaySeconds(attempts: number, messageId: string): number {
  const attempt = Number.isFinite(attempts)
    ? Math.min(Math.max(Math.trunc(attempts), 1), METRIC_EVENT_MAX_RETRIES)
    : 1;
  const base = Math.min(RETRY_BASE_SECONDS * 2 ** (attempt - 1), RETRY_MAX_SECONDS);
  return Math.min(base + Math.floor(base * jitterFraction(messageId)), RETRY_MAX_SECONDS);
}

/** FNV-1a over the message id, mapped to [0, 1). Deterministic per message. */
function jitterFraction(messageId: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < messageId.length; index += 1) {
    hash ^= messageId.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return ((hash >>> 0) % 1_000) / 1_000;
}

function logMetricEventFailure(message: Message<MetricEventRow>, error: unknown): void {
  const finalAttempt = message.attempts > METRIC_EVENT_MAX_RETRIES;
  console.error(
    finalAttempt
      ? "event-ingest-api Metric Event dead-lettered after final delivery attempt"
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
 * After the final attempt the message leaves the primary queue for the
 * dead-letter queue, where nothing consumes it yet, and the outbox has already
 * claimed the dedup key. This log line is what tells an operator the event is
 * sitting there. `dedup_key` and `targeting_key_hash` are what scope the damage
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

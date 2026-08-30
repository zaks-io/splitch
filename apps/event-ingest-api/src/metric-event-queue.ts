import { requirePlatformTarget } from "@splitch/contracts";
import {
  type Admission,
  type AdmittedRow,
  admitMetricEvent,
  deliverAdmittedRows,
} from "./metric-event-batch-delivery";
import { type PoisonedDelivery, transferToDeadLetter } from "./metric-event-dead-letter";
import { makeMetricEventSaltStore } from "./metric-event-salt-store";
import {
  transferToReconciliation,
  type UnresolvedMetricEvent,
} from "./metric-event-reconciliation";
import { tinybirdDelivery } from "./tinybird";
import type { DeliveryOutcome } from "./tinybird-microbatch";
import { QUEUE_MAX_RETRIES, queueRetryDelaySeconds } from "./queue-retry";
import type { Env } from "./types";

type MetricEventRow = Record<string, unknown>;

/** Must equal `queues.consumers[].max_retries` in wrangler.jsonc; a test holds the two together. */
export const METRIC_EVENT_MAX_RETRIES = QUEUE_MAX_RETRIES;

/**
 * Backoff floor and ceiling, in seconds. Doubling from 5 across the seven
 * configured retries spans 635 seconds, or just under twice that once jitter is
 * added, so a failing row gets a 10 to 21 minute tail: long enough to ride out a
 * Tinybird incident and short enough that a recovered pipeline drains promptly.
 * The doubling never reaches the ceiling. It is there so that no computed delay
 * can exceed the 86,400 Cloudflare accepts for a delayed message
 * (https://developers.cloudflare.com/queues/configuration/javascript-apis/).
 */
const RETRY_MAX_SECONDS = 43_200;

/**
 * Delivers a consumer batch as one bounded Tinybird request per size split,
 * never one per row.
 *
 * Each message is first admitted through the privacy authorities and claims its
 * write-ahead delivery-attempt record; only claimed rows enter the request. A
 * message whose admission or settlement throws keeps its own failure, so one
 * bad row cannot strand the rest of the batch
 * (docs/adr/0043-event-ingest-will-use-durable-queue-backed-tinybird-microbatches.md).
 */
export async function handleMetricEventQueue(
  batch: MessageBatch<MetricEventRow>,
  env: Env,
): Promise<void> {
  requirePlatformTarget(env.SPLITCH_PLATFORM_TARGET);
  makeMetricEventSaltStore(env);
  // Resolved before admission so a configuration failure never claims a
  // write-ahead record it has no way to send, which would spend the row's
  // attempt budget on a failure that never reached Tinybird.
  const delivery = tinybirdDelivery(env, "metric_events");
  if (!delivery.ok) {
    for (const message of batch.messages) retryMessage(message, new Error(delivery.error.message));
    return;
  }
  const attemptId = crypto.randomUUID();
  const admissions = await Promise.all(
    batch.messages.map(async (message) => {
      try {
        return { message, admission: await admitMetricEvent(message, env, attemptId) };
      } catch (error) {
        retryMessage(message, error);
        return undefined;
      }
    }),
  );

  const admitted: AdmittedRow[] = [];
  const poisoned: PoisonedDelivery[] = [];
  const unresolved: UnresolvedMetricEvent[] = [];
  for (const entry of admissions) {
    if (!entry) continue;
    collectAdmission(entry.message, entry.admission, admitted, poisoned, unresolved);
  }

  try {
    const deliveryResults = await deliverAdmittedRows(admitted, env, delivery.value);
    settleDeliveryResults(admitted, deliveryResults, poisoned, unresolved);
  } catch (error) {
    // A write-ahead record left `attempting` is never blindly re-sent. The next
    // invocation hands it to reconciliation, which proves commit or absence.
    for (const entry of admitted) retryMessage(entry.message, error);
    logBatchFailure(admitted.length, error);
  }

  await transferUnresolved(unresolved, env);
  await transferPoisoned(poisoned, env);
  console.info("event-ingest-api Metric Event batch settled", {
    queue: batch.queue,
    attemptId,
    rowCount: batch.messages.length,
    attemptedDeliveryCount: admitted.length,
    unresolvedCount: unresolved.length,
    poisonCount: poisoned.length,
    backlogCount: batch.metadata.metrics.backlogCount,
    backlogBytes: batch.metadata.metrics.backlogBytes,
    oldestMessageTimestamp: oldestMessageTimestamp(batch.messages),
  });
}

function settleDeliveryResults(
  admitted: readonly AdmittedRow[],
  results: Awaited<ReturnType<typeof deliverAdmittedRows>>,
  poisoned: PoisonedDelivery[],
  unresolved: UnresolvedMetricEvent[],
): void {
  for (const entry of admitted) {
    const settlementFailure = results.settlementFailures.get(entry.message);
    if (settlementFailure !== undefined) {
      retryMessage(entry.message, settlementFailure);
      continue;
    }
    settleAdmitted(entry, results.outcomes.get(entry.message), poisoned, unresolved);
  }
}

function oldestMessageTimestamp(messages: readonly Message<MetricEventRow>[]): string | null {
  if (messages.length === 0) return null;
  return new Date(
    Math.min(...messages.map((message) => message.timestamp.getTime())),
  ).toISOString();
}

function collectAdmission(
  message: Message<MetricEventRow>,
  admission: Admission,
  admitted: AdmittedRow[],
  poisoned: PoisonedDelivery[],
  unresolved: UnresolvedMetricEvent[],
): void {
  if (admission.kind === "send") {
    admitted.push(admission.admitted);
    return;
  }
  if (admission.kind === "ack") {
    message.ack();
    return;
  }
  if (admission.attempt.state !== "poison_pending") {
    console.error("event-ingest-api Metric Event delivery is unresolved", {
      queueMessageId: message.id,
      dedupKey: admission.dedupKey,
      attemptId: admission.attempt.attemptId,
      reason: admission.reason,
    });
    unresolved.push({
      message,
      dedupKey: admission.dedupKey,
      attempt: admission.attempt,
      reason: admission.reason,
    });
    return;
  }
  poisoned.push({
    message,
    dedupKey: admission.dedupKey,
    attempt: admission.attempt,
    reason: admission.reason,
  });
}

function settleAdmitted(
  entry: AdmittedRow,
  outcome: DeliveryOutcome | undefined,
  poisoned: PoisonedDelivery[],
  unresolved: UnresolvedMetricEvent[],
): void {
  if (!outcome) {
    throw new Error("Metric Event delivery produced no outcome for an admitted row");
  }
  if (outcome.kind === "delivered") {
    entry.message.ack();
    return;
  }
  if (outcome.kind === "retryable") {
    logMetricEventFailure(entry.message, new Error(outcome.reason));
    entry.message.retry({
      delaySeconds:
        // Tinybird's `Retry-After` may be an HTTP date arbitrarily far out. Past
        // the delay Queues accepts, `retry` throws and the message loses the
        // attempt entirely, so the upstream hint is honored only up to our own
        // ceiling.
        clampDelaySeconds(outcome.retryAfterSeconds) ??
        metricEventRetryDelaySeconds(entry.message.attempts, entry.message.id),
    });
    return;
  }
  if (outcome.kind === "indeterminate") {
    console.error("event-ingest-api Metric Event delivery is unresolved", {
      queueMessageId: entry.message.id,
      dedupKey: entry.dedupKey,
      attemptId: entry.attempt.attemptId,
      reason: outcome.reason,
    });
    unresolved.push({
      message: entry.message,
      dedupKey: entry.dedupKey,
      attempt: { ...entry.attempt, state: "indeterminate", reason: outcome.reason },
      reason: outcome.reason,
    });
    return;
  }
  // Logged here rather than only in the transfer, because this is the line that
  // carries every identifier of the event an operator has to go find.
  logMetricEventFailure(entry.message, new Error(outcome.reason));
  poisoned.push({
    message: entry.message,
    dedupKey: entry.dedupKey,
    attempt: entry.attempt,
    reason: outcome.reason,
  });
}

async function transferUnresolved(unresolved: UnresolvedMetricEvent[], env: Env): Promise<void> {
  if (unresolved.length === 0) return;
  try {
    await transferToReconciliation(unresolved, env);
  } catch (error) {
    for (const entry of unresolved) retryMessage(entry.message, error);
  }
}

function clampDelaySeconds(seconds: number | undefined): number | undefined {
  if (seconds === undefined) return undefined;
  return Math.min(Math.max(seconds, 0), RETRY_MAX_SECONDS);
}

/** Acknowledgement follows the dead-letter copy, never precedes it. */
async function transferPoisoned(poisoned: PoisonedDelivery[], env: Env): Promise<void> {
  if (poisoned.length === 0) return;
  try {
    await transferToDeadLetter(poisoned, env);
    for (const entry of poisoned) entry.message.ack();
  } catch (error) {
    // `poison_pending` survives, so the redelivery resumes the copy without
    // ever touching Tinybird again.
    for (const entry of poisoned) retryMessage(entry.message, error);
  }
}

function retryMessage(message: Message<MetricEventRow>, error: unknown): void {
  logMetricEventFailure(message, error);
  message.retry({ delaySeconds: metricEventRetryDelaySeconds(message.attempts, message.id) });
}

function logBatchFailure(rowCount: number, error: unknown): void {
  console.error("event-ingest-api Metric Event batch delivery failed", {
    rowCount,
    errorMessage: error instanceof Error ? error.message : "non-error rejection",
  });
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
  return queueRetryDelaySeconds(attempts, messageId);
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

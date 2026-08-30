import { admitEntityIdentityRow } from "./entity-identity-row-delivery";
import { identityVersionForRow } from "./entity-metric-privacy";
import {
  beginMetricEventDelivery,
  type MetricEventDeliveryAttempt,
  type MetricEventDeliveryState,
  settleMetricEventDelivery,
} from "./metric-event-delivery-attempt";
import {
  type DeliveryOutcome,
  MAX_DELIVERY_ATTEMPTS,
  ndjsonBatches,
  sendNdjsonBatch,
} from "./tinybird-microbatch";
import type { Env, TinybirdDelivery } from "./types";

type MetricEventRow = Record<string, unknown>;

/** One admitted row, still holding the queue message that owes an acknowledgement. */
export interface AdmittedRow {
  readonly message: Message<MetricEventRow>;
  readonly dedupKey: string;
  readonly row: MetricEventRow;
  readonly attempt: MetricEventDeliveryAttempt;
}

/** What a message's admission decided, for the caller that owns ack and retry. */
export type Admission =
  | { kind: "send"; admitted: AdmittedRow }
  /** Suppressed, already delivered, or already dead-lettered: acknowledge it. */
  | { kind: "ack"; reason: string }
  /** Open from an earlier invocation, or poisoned: never resubmitted to Tinybird. */
  | { kind: "recover"; attempt: MetricEventDeliveryAttempt; dedupKey: string; reason: string };

/**
 * Asks the privacy authorities whether a row may still be sent, then claims the
 * write-ahead delivery-attempt record that must exist before any Tinybird call.
 *
 * The order matters both ways. Admission first means a suppressed row never
 * creates an attempt record. The claim second means a privacy deletion that
 * lands in between finds the outbox record already claimed and refuses to
 * return a deletion proof while the row is in flight
 * (docs/adr/0043-event-ingest-will-use-durable-queue-backed-tinybird-microbatches.md).
 */
export async function admitMetricEvent(
  message: Message<MetricEventRow>,
  env: Env,
  attemptId: string,
): Promise<Admission> {
  const dedupKey = message.body.dedup_key;
  if (typeof dedupKey !== "string" || dedupKey.length === 0) {
    throw new Error("Metric Event row has no dedup_key");
  }
  const suppressed = await admitEntityIdentityRow(
    env.ENTITY_METRIC_PRIVACY,
    identityVersionForRow(message.body),
    "metric_events",
    message.body,
    env.SPLITCH_PLATFORM_TARGET,
  );
  if (suppressed) return { kind: "ack", reason: "privacy-suppressed" };
  const begun = await beginMetricEventDelivery(env.METRIC_EVENT_OUTBOX, dedupKey, attemptId);
  switch (begun.kind) {
    case "claimed":
      return {
        kind: "send",
        admitted: { message, dedupKey, row: begun.row, attempt: begun.attempt },
      };
    case "deleted":
      return { kind: "ack", reason: "privacy-deleted" };
    case "settled":
      return { kind: "ack", reason: begun.state };
    case "unresolved":
      return {
        kind: "recover",
        attempt: begun.attempt,
        dedupKey,
        reason: `unresolved ${begun.attempt.state} attempt`,
      };
    case "poison":
      return {
        kind: "recover",
        attempt: begun.attempt,
        dedupKey,
        reason: begun.attempt.reason ?? "delivery attempts exhausted",
      };
  }
}

/**
 * Sends every admitted row as bounded gzip NDJSON and records the outcome
 * against each row's write-ahead record.
 *
 * Splits are sequential and never degrade to one request per row: the whole
 * point of the queue is that request count stops scaling with event count.
 */
export async function deliverAdmittedRows(
  admitted: readonly AdmittedRow[],
  env: Env,
  delivery: TinybirdDelivery,
): Promise<Map<Message<MetricEventRow>, DeliveryOutcome>> {
  const outcomes = new Map<Message<MetricEventRow>, DeliveryOutcome>();
  if (admitted.length === 0) return outcomes;
  for (const batch of ndjsonBatches(admitted, (entry) => entry.row)) {
    const outcome = await sendNdjsonBatch(batch.body, batch.items.length, delivery);
    for (const entry of batch.items) {
      outcomes.set(
        entry.message,
        exhausted(entry.message) ? poisonInsteadOfRetry(outcome) : outcome,
      );
    }
    // Every settle targets a different per-dedup-key object, so nothing orders
    // them against each other. Awaiting them one at a time made the batch cost a
    // hundred serial round trips, which is the same per-row latency the
    // microbatch exists to remove, just moved from Tinybird to the outbox.
    await Promise.all(
      batch.items.map((entry) => {
        const settled = outcomes.get(entry.message);
        if (!settled)
          throw new Error("Metric Event delivery produced no outcome for an admitted row");
        return settleMetricEventDelivery(env.METRIC_EVENT_OUTBOX, entry.dedupKey, {
          ...entry.attempt,
          state: settledState(settled),
          reason: settled.kind === "delivered" ? undefined : settled.reason,
        });
      }),
    );
  }
  return outcomes;
}

/**
 * Whether Cloudflare will hand this message back at all after the current
 * delivery. `attempts` is 1-based, so the last delivery equals the ceiling.
 */
function exhausted(message: Message<MetricEventRow>): boolean {
  return message.attempts >= MAX_DELIVERY_ATTEMPTS;
}

/**
 * On the final delivery a retryable failure is terminal, so it takes the poison
 * path here rather than asking for a retry that will never come. Retrying
 * instead would let Cloudflare move the message to its own dead-letter queue
 * with none of the failure metadata `deadLetterEnvelope` carries, and would
 * leave the write-ahead record stuck at `retryable` forever.
 */
function poisonInsteadOfRetry(outcome: DeliveryOutcome): DeliveryOutcome {
  if (outcome.kind !== "retryable") return outcome;
  return {
    kind: "poison",
    reason: `${outcome.reason} on the final of ${MAX_DELIVERY_ATTEMPTS} delivery attempts`,
  };
}

function settledState(outcome: DeliveryOutcome): MetricEventDeliveryState {
  if (outcome.kind === "delivered") return "delivered";
  if (outcome.kind === "retryable") return "retryable";
  if (outcome.kind === "indeterminate") return "indeterminate";
  return "poison_pending";
}

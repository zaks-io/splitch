import {
  type MetricEventDeliveryAttempt,
  settleMetricEventDelivery,
} from "./metric-event-delivery-attempt";
import type { Env } from "./types";

type MetricEventRow = Record<string, unknown>;

export interface PoisonedDelivery {
  readonly message: Message<MetricEventRow>;
  readonly dedupKey: string;
  readonly attempt: MetricEventDeliveryAttempt;
  readonly reason: string;
}

/**
 * Cloudflare rejects a `sendBatch` over 100 messages or 256 KB, counting 1 KB as
 * 1,000 bytes and adding about 100 bytes of metadata per message
 * (https://developers.cloudflare.com/queues/platform/limits/). ADR-0043 splits
 * producer batches at 240,000 aggregate bytes, which leaves that metadata room
 * for a full 100-message chunk.
 */
const DLQ_MAX_MESSAGES = 100;
const DLQ_MAX_BATCH_BYTES = 240_000;

/**
 * Copies poisoned deliveries to the dead-letter queue, then records the
 * terminal `poison_transferred` state, then lets the caller acknowledge.
 *
 * The order is the whole point: acknowledging before the copy lands would
 * destroy accepted events, and the two poison states exist so that a failed
 * copy resumes here on redelivery instead of becoming an ordinary Tinybird
 * retry loop
 * (docs/adr/0043-event-ingest-will-use-durable-queue-backed-tinybird-microbatches.md).
 *
 * Each chunk settles as soon as it lands, so a later chunk's failure costs only
 * its own entries: the settled ones come back `poison_transferred` on redelivery
 * and are acknowledged without a second copy.
 */
export async function transferToDeadLetter(
  poisoned: readonly PoisonedDelivery[],
  env: Env,
): Promise<void> {
  if (poisoned.length === 0) return;
  if (!env.METRIC_EVENTS_DLQ) throw new Error("METRIC_EVENTS_DLQ binding is unavailable");
  for (const chunk of deadLetterChunks(poisoned)) {
    await env.METRIC_EVENTS_DLQ.sendBatch(chunk.map((entry) => ({ body: entry.envelope })));
    for (const entry of chunk) {
      await settleMetricEventDelivery(env.METRIC_EVENT_OUTBOX, entry.dedupKey, {
        ...entry.attempt,
        state: "poison_transferred",
        reason: entry.reason,
      });
    }
  }
  console.error("event-ingest-api Metric Event deliveries dead-lettered", {
    count: poisoned.length,
    attemptId: poisoned[0]?.attempt.attemptId,
    reason: poisoned[0]?.reason,
    dedupKeys: poisoned.map((entry) => entry.dedupKey),
  });
}

interface DeadLetterEntry extends PoisonedDelivery {
  readonly envelope: MetricEventRow;
}

/**
 * Split into the fewest chunks inside both Queue ceilings. An envelope too large
 * to share a batch is sent alone and fails loud at Cloudflare, never dropped:
 * the same rule `ndjsonBatches` applies to an oversized row.
 */
function deadLetterChunks(poisoned: readonly PoisonedDelivery[]): DeadLetterEntry[][] {
  const chunks: DeadLetterEntry[][] = [];
  let current: DeadLetterEntry[] = [];
  let bytes = 0;
  for (const entry of poisoned) {
    const envelope = deadLetterEnvelope(entry);
    const size = byteLength(JSON.stringify(envelope));
    const full = current.length >= DLQ_MAX_MESSAGES || bytes + size > DLQ_MAX_BATCH_BYTES;
    if (current.length > 0 && full) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push({ ...entry, envelope });
    bytes += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * Discriminates our envelope from the bare Metric Event row Cloudflare copies in
 * on its own when a message exhausts `max_retries` outside this path, such as a
 * failure before the row ever had a dedup key. Both shapes land in the same
 * queue, so a replay consumer branches on this field and refuses anything it
 * does not recognize rather than guessing at the shape.
 */
const DEAD_LETTER_KIND = "metric-event-delivery-failure-v1";

/**
 * The original row plus why it failed. The row is carried whole so a manual
 * replay preserves every retry-stable `dedup_key`; the failure metadata rides
 * beside it rather than inside it, so nothing ever contaminates the datasource
 * schema.
 */
function deadLetterEnvelope(entry: PoisonedDelivery): MetricEventRow {
  return {
    kind: DEAD_LETTER_KIND,
    row: entry.message.body,
    failure: {
      datasource: "metric_events",
      dedupKey: entry.dedupKey,
      queueMessageId: entry.message.id,
      attemptId: entry.attempt.attemptId,
      attempts: entry.attempt.attempts,
      reason: entry.reason,
    },
  };
}

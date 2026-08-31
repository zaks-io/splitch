import { queuePayloadBytes } from "./ingest-admission-gate";
import type { IngestPhaseTiming } from "./ingest-phase-timing";
import type { RawEventDatasource } from "./raw-event-queue-envelope";

type RawEventOutcome = "delivered" | "retryable" | "indeterminate" | "poison" | "suppressed";
export type RawEventOutcomeCounts = Record<RawEventOutcome, number>;

export function emptyRawEventOutcomeCounts(): RawEventOutcomeCounts {
  return { delivered: 0, retryable: 0, indeterminate: 0, poison: 0, suppressed: 0 };
}

export function emitRawEventBatchSettlement(
  timing: IngestPhaseTiming,
  batch: MessageBatch<Record<string, unknown>>,
  datasource: RawEventDatasource,
  outcomes: RawEventOutcomeCounts,
): void {
  const oldestTimestamp = oldestMessageTimestamp(batch.messages);
  timing.emit(batchTimingOutcome(outcomes), {
    serializedBytes: batch.messages.reduce(
      (total, message) => total + queuePayloadBytes(message.body),
      0,
    ),
    itemCount: batch.messages.length,
    queue: batch.queue,
    datasource,
    rowCount: batch.messages.length,
    deliveredCount: outcomes.delivered,
    retryableCount: outcomes.retryable,
    indeterminateCount: outcomes.indeterminate,
    poisonCount: outcomes.poison,
    suppressedCount: outcomes.suppressed,
    backlogCount: batch.metadata.metrics.backlogCount,
    backlogBytes: batch.metadata.metrics.backlogBytes,
    oldestMessageTimestamp: oldestTimestamp?.toISOString() ?? null,
    oldestMessageAgeMs: oldestTimestamp
      ? Math.max(0, Date.now() - oldestTimestamp.getTime())
      : null,
  });
}

function batchTimingOutcome(outcomes: RawEventOutcomeCounts): "accepted" | "rejected" | "fault" {
  if (outcomes.retryable + outcomes.indeterminate + outcomes.poison > 0) return "fault";
  if (outcomes.delivered === 0 && outcomes.suppressed > 0) return "rejected";
  return "accepted";
}

function oldestMessageTimestamp(
  messages: readonly Message<Record<string, unknown>>[],
): Date | undefined {
  if (messages.length === 0) return undefined;
  return new Date(Math.min(...messages.map((message) => message.timestamp.getTime())));
}

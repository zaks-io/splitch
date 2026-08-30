import type { RawEventDatasource } from "./raw-event-queue-envelope";

type RawEventOutcome = "delivered" | "retryable" | "indeterminate" | "poison" | "suppressed";
export type RawEventOutcomeCounts = Record<RawEventOutcome, number>;

export function emptyRawEventOutcomeCounts(): RawEventOutcomeCounts {
  return { delivered: 0, retryable: 0, indeterminate: 0, poison: 0, suppressed: 0 };
}

export function logRawEventBatchSettlement(
  batch: MessageBatch<Record<string, unknown>>,
  datasource: RawEventDatasource,
  outcomes: RawEventOutcomeCounts,
): void {
  const oldestTimestamp = oldestMessageTimestamp(batch.messages);
  console.info("event-ingest-api raw event batch settled", {
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

function oldestMessageTimestamp(
  messages: readonly Message<Record<string, unknown>>[],
): Date | undefined {
  if (messages.length === 0) return undefined;
  return new Date(Math.min(...messages.map((message) => message.timestamp.getTime())));
}

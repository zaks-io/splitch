import type { MetricEventOutboxNamespace } from "./metric-event-outbox";
import { MAX_DELIVERY_ATTEMPTS } from "./tinybird-microbatch";

/**
 * The write-ahead delivery-attempt record ADR-0043 requires before any Tinybird
 * call, stored on the per-dedup-key Metric Event outbox record.
 *
 * That record is already the canonical payload reference and already what a
 * privacy deletion suppresses, so the attempt state is App- and
 * Entity-deletion suppressible by construction, and a redelivered queue message
 * finds its own attempt by the dedup key it carries.
 *
 * docs/adr/0043-event-ingest-will-use-durable-queue-backed-tinybird-microbatches.md
 */
export type MetricEventDeliveryState =
  | "attempting"
  | "retryable"
  | "delivered"
  | "indeterminate"
  | "poison_pending"
  | "poison_transferred";

export interface MetricEventDeliveryAttempt {
  readonly attemptId: string;
  readonly state: MetricEventDeliveryState;
  readonly attempts: number;
  readonly reason?: string;
  readonly reconciliation?:
    | { readonly kind: "copy-starting"; readonly claimedAt: string }
    | { readonly kind: "copy-job"; readonly jobId: string };
}

/**
 * States that still owe an answer to a *concurrent* privacy deletion. A
 * deletion may not clear the referenced payload while one is open.
 *
 * `attempting` is ambiguous after ownership changes: the prior invocation may
 * have reached Tinybird before it died. It blocks deletion and can only move
 * through reconciliation, exactly like an indeterminate response.
 */
const BLOCKS_DELETION: readonly MetricEventDeliveryState[] = [
  "attempting",
  "indeterminate",
  "poison_pending",
];

export function isUnresolved(attempt: MetricEventDeliveryAttempt | undefined): boolean {
  return attempt !== undefined && BLOCKS_DELETION.includes(attempt.state);
}

export type BeginOutcome =
  /** Claimed the write-ahead record; the row belongs in this Tinybird request. */
  | { kind: "claimed"; row: Record<string, unknown>; attempt: MetricEventDeliveryAttempt }
  /** A privacy deletion already redacted the payload. Nothing to deliver. */
  | { kind: "deleted" }
  /** Terminal: acknowledge the queue message without calling Tinybird. */
  | { kind: "settled"; state: MetricEventDeliveryState }
  /** Tinybird's answer was ambiguous: reconcile, never resubmit. */
  | { kind: "unresolved"; attempt: MetricEventDeliveryAttempt }
  /** Retries exhausted; the message is owed a dead-letter transfer. */
  | { kind: "poison"; attempt: MetricEventDeliveryAttempt };

/**
 * Decides what a queue message may do next, from the durable record alone.
 *
 * Kept apart from the Durable Object so the state machine is testable without a
 * storage stub, and so the object has exactly one place that writes it.
 */
export function beginDelivery(
  existing: MetricEventDeliveryAttempt | undefined,
  attemptId: string,
): {
  outcome: Exclude<BeginOutcome, { kind: "claimed" } | { kind: "deleted" }> | undefined;
  next?: MetricEventDeliveryAttempt;
} {
  if (existing === undefined) {
    return { outcome: undefined, next: { attemptId, state: "attempting", attempts: 1 } };
  }
  if (existing.state === "delivered" || existing.state === "poison_transferred") {
    return { outcome: { kind: "settled", state: existing.state } };
  }
  if (existing.state === "indeterminate") {
    // Tinybird answered ambiguously. Re-sending could duplicate a committed row
    // and acknowledging could lose one, so only reconciliation may resolve it.
    return { outcome: { kind: "unresolved", attempt: existing } };
  }
  if (existing.state === "attempting") {
    return { outcome: { kind: "unresolved", attempt: existing } };
  }
  if (existing.state === "poison_pending") {
    return { outcome: { kind: "poison", attempt: existing } };
  }
  // Only an explicitly retryable Tinybird response may be resubmitted. An
  // attempting or indeterminate record above has no proof that the first
  // request was absent and therefore belongs to reconciliation.
  const attempts = existing.attempts + 1;
  if (attempts > MAX_DELIVERY_ATTEMPTS) {
    const attempt = {
      attemptId,
      state: "poison_pending",
      attempts,
      reason: existing.reason,
    } as const;
    return { outcome: { kind: "poison", attempt }, next: attempt };
  }
  return { outcome: undefined, next: { attemptId, state: "attempting", attempts } };
}

/** Claims the write-ahead record for a row, or explains why the row is not deliverable. */
export async function beginMetricEventDelivery(
  namespace: MetricEventOutboxNamespace | undefined,
  dedupKey: string,
  attemptId: string,
): Promise<BeginOutcome> {
  const response = await outboxFetch(namespace, dedupKey, "/begin-delivery", { attemptId });
  return (await response.json()) as BeginOutcome;
}

/** Records the outcome of a Tinybird request against the same write-ahead record. */
export async function settleMetricEventDelivery(
  namespace: MetricEventOutboxNamespace | undefined,
  dedupKey: string,
  attempt: MetricEventDeliveryAttempt,
): Promise<void> {
  await outboxFetch(namespace, dedupKey, "/settle-delivery", attempt);
}

/** Reads the current attempt before reconciliation performs an external side effect. */
export async function readMetricEventDelivery(
  namespace: MetricEventOutboxNamespace | undefined,
  dedupKey: string,
): Promise<MetricEventDeliveryAttempt | undefined> {
  if (!namespace) throw new Error("METRIC_EVENT_OUTBOX binding is unavailable");
  const response = await namespace
    .get(namespace.idFromName(dedupKey))
    .fetch("https://metric-event-outbox.local/delivery", { method: "GET" });
  if (response.status === 404) return undefined;
  if (!response.ok) {
    throw new Error(`Metric Event outbox /delivery returned HTTP ${response.status}`);
  }
  return (await response.json()) as MetricEventDeliveryAttempt;
}

async function outboxFetch(
  namespace: MetricEventOutboxNamespace | undefined,
  dedupKey: string,
  path: string,
  body: unknown,
): Promise<Response> {
  if (!namespace) throw new Error("METRIC_EVENT_OUTBOX binding is unavailable");
  const response = await namespace
    .get(namespace.idFromName(dedupKey))
    .fetch(`https://metric-event-outbox.local${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  if (!response.ok) {
    throw new Error(`Metric Event outbox ${path} returned HTTP ${response.status}`);
  }
  return response;
}

/**
 * Drives the Metric Event queue consumer end to end, so the batching tests and
 * the write-ahead lifecycle tests exercise one consumer through one seam
 * instead of each keeping its own copy of the row and the queue message.
 */
import { type Mock, vi } from "vitest";
import worker from "./index";
import type { QueueFixture } from "./metric-event-queue-test-fixture";
import type { Env } from "./types";

export function metricEvent(eventId: string): Record<string, unknown> {
  return {
    dedup_key: `sha256:${eventId}`,
    event_id: eventId,
    app_id: "app_shop",
    environment_id: "env_prod",
    event_definition_id: "event_definition_checkout",
    event_definition_version_id: "event_definition_version_checkout_3",
    event_name: "checkout_completed",
    id_type: "user",
    entity_family_hash: `v1:${eventId}-family`,
    targeting_key_hash: `v1:${eventId}-targeting-key`,
    fields: JSON.stringify({ converted: true }),
    dimensions: JSON.stringify({ plan: "pro" }),
    server_received_at: "2026-08-07T00:00:00.000Z",
  };
}

/** A queue message whose ack and retry a test can assert against. */
export interface QueuedMetricEvent extends Message<Record<string, unknown>> {
  readonly ack: Mock<() => void>;
  readonly retry: Mock<(options?: QueueRetryOptions) => void>;
}

export function queueMessage(eventId: string, attempts = 2): QueuedMetricEvent {
  return {
    id: `queue-${eventId}`,
    timestamp: new Date("2026-08-07T00:00:00.000Z"),
    body: metricEvent(eventId),
    attempts,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

export async function seal(
  fixture: QueueFixture,
  eventIds: readonly string[],
): Promise<QueuedMetricEvent[]> {
  for (const eventId of eventIds) await fixture.seal(metricEvent(eventId));
  return eventIds.map((eventId) => queueMessage(eventId));
}

export async function sealOne(fixture: QueueFixture, eventId: string): Promise<QueuedMetricEvent> {
  const [message] = await seal(fixture, [eventId]);
  if (!message) throw new Error("seal produced no queue message");
  return message;
}

export async function deliver(env: Env, messages: readonly QueuedMetricEvent[]): Promise<void> {
  if (!worker.queue) throw new Error("Event ingest queue handler is not configured");
  await worker.queue(
    {
      messages,
      queue: "splitch-metric-events",
      metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
      ackAll: vi.fn(),
      retryAll: vi.fn(),
    } satisfies MessageBatch<Record<string, unknown>>,
    env,
    {} as ExecutionContext,
  );
}

export async function suppress(env: Env, row: Record<string, unknown>): Promise<Response> {
  const outbox = env.METRIC_EVENT_OUTBOX;
  if (!outbox) throw new Error("fixture outbox is missing");
  return outbox
    .get(outbox.idFromName(String(row.dedup_key)))
    .fetch("https://metric-event-outbox.local/suppress", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        fingerprint: `fingerprint:${String(row.event_id)}`,
        eventDefinitionId: String(row.event_definition_id),
        eventDefinitionVersionId: String(row.event_definition_version_id),
      }),
    });
}

export function commit(rows: number) {
  return { successful_rows: rows, quarantined_rows: 0 };
}

export function stubTinybird(body: unknown, init: ResponseInit = {}) {
  const fetch = vi.fn(async (_url: string, _init: RequestInit) =>
    body === undefined
      ? new Response(null, { status: 500, ...init })
      : new Response(JSON.stringify(body), { status: 200, ...init }),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

export type TinybirdStub = ReturnType<typeof stubTinybird>;

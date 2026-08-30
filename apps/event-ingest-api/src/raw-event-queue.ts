import { requirePlatformTarget } from "@splitch/contracts";
import { admitEntityIdentityRow } from "./entity-identity-row-delivery";
import { admitAppIdentityRow, identityVersionForRow } from "./entity-metric-privacy";
import { queueRetryDelaySeconds } from "./queue-retry";
import { tinybirdDelivery } from "./tinybird";
import { ndjsonBatches, sendNdjsonBatch } from "./tinybird-microbatch";
import type { Env } from "./types";

export type RawEventDatasource = "raw_events" | "raw_evaluations";

interface RawEventQueueEnvelope extends Record<string, unknown> {
  readonly kind: "raw-event-delivery-v1";
  readonly datasource: RawEventDatasource;
  readonly row: Record<string, unknown>;
}

interface AdmittedRawEvent {
  readonly message: Message<Record<string, unknown>>;
  readonly envelope: RawEventQueueEnvelope;
}

export async function enqueueRawEvent(
  env: Env,
  datasource: RawEventDatasource,
  row: Record<string, unknown>,
): Promise<void> {
  await requiredQueue(env, datasource).send(envelope(datasource, row));
}

export async function enqueueRawEvents(
  env: Env,
  datasource: RawEventDatasource,
  rows: readonly Record<string, unknown>[],
): Promise<void> {
  if (rows.length === 0) return;
  await requiredQueue(env, datasource).sendBatch(
    rows.map((row) => ({ body: envelope(datasource, row) })),
  );
}

/**
 * Queue handoff is the intake durability boundary. The consumer owns privacy
 * admission and Tinybird latency, so a slow analytics sink cannot hold an SDK
 * Evaluation response open.
 */
export async function handleRawEventQueue(
  batch: MessageBatch<Record<string, unknown>>,
  env: Env,
): Promise<void> {
  requirePlatformTarget(env.SPLITCH_PLATFORM_TARGET);
  const queueDatasource = datasourceForQueue(batch.queue);
  const groups = await admitBatch(batch.messages, queueDatasource, env);
  for (const [datasource, admitted] of groups) await deliverGroup(datasource, admitted, env);
}

async function admitBatch(
  messages: readonly Message<Record<string, unknown>>[],
  queueDatasource: RawEventDatasource,
  env: Env,
): Promise<Map<RawEventDatasource, AdmittedRawEvent[]>> {
  const groups = new Map<RawEventDatasource, AdmittedRawEvent[]>();
  await Promise.all(
    messages.map(async (message) => {
      try {
        const queued = parseEnvelope(message.body);
        if (queued.datasource !== queueDatasource) {
          throw new Error(`${queued.datasource} envelope arrived on ${queueDatasource} queue`);
        }
        if (await isSuppressed(queued, env)) {
          message.ack();
          return;
        }
        const group = groups.get(queued.datasource) ?? [];
        group.push({ message, envelope: queued });
        groups.set(queued.datasource, group);
      } catch (error) {
        retry(message, error);
      }
    }),
  );
  return groups;
}

async function deliverGroup(
  datasource: RawEventDatasource,
  admitted: readonly AdmittedRawEvent[],
  env: Env,
): Promise<void> {
  const delivery = tinybirdDelivery(env, datasource);
  if (!delivery.ok) {
    for (const item of admitted) retry(item.message, new Error(delivery.error.message));
    return;
  }
  for (const microbatch of ndjsonBatches(admitted, (item) => item.envelope.row)) {
    const outcome = await sendNdjsonBatch(microbatch.body, microbatch.items.length, delivery.value);
    for (const item of microbatch.items) settle(item, outcome);
  }
}

function datasourceForQueue(queue: string): RawEventDatasource {
  if (queue.includes("raw-evaluations")) return "raw_evaluations";
  if (queue.includes("raw-events")) return "raw_events";
  throw new Error(`unknown raw event queue ${queue}`);
}

async function isSuppressed(queued: RawEventQueueEnvelope, env: Env): Promise<boolean> {
  if (queued.datasource === "raw_events") {
    return admitEntityIdentityRow(
      env.ENTITY_METRIC_PRIVACY,
      identityVersionForRow(queued.row),
      queued.datasource,
      queued.row,
      env.SPLITCH_PLATFORM_TARGET,
    );
  }
  const appId = queued.row.app_id;
  if (typeof appId !== "string" || appId.length === 0) {
    throw new Error("raw_evaluations row has no app_id");
  }
  return admitAppIdentityRow(
    env.ENTITY_METRIC_PRIVACY,
    appId,
    identityVersionForRow(queued.row),
    queued.datasource,
    queued.row,
    env.SPLITCH_PLATFORM_TARGET,
  );
}

function settle(
  item: AdmittedRawEvent,
  outcome: Awaited<ReturnType<typeof sendNdjsonBatch>>,
): void {
  if (outcome.kind === "delivered") {
    item.message.ack();
    return;
  }
  const error = new Error(outcome.reason);
  console.error("event-ingest-api raw event delivery failed", {
    datasource: item.envelope.datasource,
    queueMessageId: item.message.id,
    attempts: item.message.attempts,
    errorMessage: error.message,
  });
  item.message.retry({
    delaySeconds:
      outcome.kind === "retryable" && outcome.retryAfterSeconds !== undefined
        ? Math.min(Math.max(outcome.retryAfterSeconds, 0), 43_200)
        : queueRetryDelaySeconds(item.message.attempts, item.message.id),
  });
}

function retry(message: Message<Record<string, unknown>>, error: unknown): void {
  console.error("event-ingest-api raw event queue admission failed", {
    queueMessageId: message.id,
    attempts: message.attempts,
    errorMessage: error instanceof Error ? error.message : "non-error rejection",
  });
  message.retry({ delaySeconds: queueRetryDelaySeconds(message.attempts, message.id) });
}

function envelope(
  datasource: RawEventDatasource,
  row: Record<string, unknown>,
): RawEventQueueEnvelope {
  return { kind: "raw-event-delivery-v1", datasource, row };
}

function parseEnvelope(value: Record<string, unknown>): RawEventQueueEnvelope {
  if (
    value.kind !== "raw-event-delivery-v1" ||
    (value.datasource !== "raw_events" && value.datasource !== "raw_evaluations") ||
    !isRecord(value.row)
  ) {
    throw new Error("raw event queue envelope is invalid");
  }
  return value as RawEventQueueEnvelope;
}

function requiredQueue(env: Env, datasource: RawEventDatasource): Queue<Record<string, unknown>> {
  const queue = datasource === "raw_events" ? env.RAW_EVENTS_QUEUE : env.RAW_EVALUATIONS_QUEUE;
  if (!queue) throw new Error(`${datasource} queue binding is unavailable`);
  return queue;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

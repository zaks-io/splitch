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

interface RawEventFailureEnvelope extends Record<string, unknown> {
  readonly kind: "raw-event-delivery-failure-v1";
  readonly classification: "indeterminate" | "poison";
  readonly reason: string;
  readonly sourceMessageId: string;
  readonly sourceAttempts: number;
  readonly original: RawEventQueueEnvelope;
}

const DLQ_MAX_MESSAGES = 100;
const DLQ_MAX_BATCH_BYTES = 240_000;
const DLQ_MAX_MESSAGE_BYTES = 120_000;

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
    await settleMicrobatch(datasource, microbatch.items, outcome, env);
  }
}

async function settleMicrobatch(
  datasource: RawEventDatasource,
  items: readonly AdmittedRawEvent[],
  outcome: Awaited<ReturnType<typeof sendNdjsonBatch>>,
  env: Env,
): Promise<void> {
  if (outcome.kind === "delivered") {
    for (const item of items) item.message.ack();
    return;
  }
  if (outcome.kind === "retryable") {
    for (const item of items) retryDelivery(item, outcome);
    return;
  }
  await transferTerminalFailure(datasource, items, outcome, env);
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

function retryDelivery(
  item: AdmittedRawEvent,
  outcome: Extract<Awaited<ReturnType<typeof sendNdjsonBatch>>, { kind: "retryable" }>,
): void {
  const error = new Error(outcome.reason);
  console.error("event-ingest-api raw event delivery failed", {
    datasource: item.envelope.datasource,
    queueMessageId: item.message.id,
    attempts: item.message.attempts,
    errorMessage: error.message,
  });
  item.message.retry({
    delaySeconds:
      outcome.retryAfterSeconds !== undefined
        ? Math.min(Math.max(outcome.retryAfterSeconds, 0), 43_200)
        : queueRetryDelaySeconds(item.message.attempts, item.message.id),
  });
}

async function transferTerminalFailure(
  datasource: RawEventDatasource,
  items: readonly AdmittedRawEvent[],
  outcome: Extract<
    Awaited<ReturnType<typeof sendNdjsonBatch>>,
    { kind: "indeterminate" | "poison" }
  >,
  env: Env,
): Promise<void> {
  const chunks = failureChunks(items, outcome);
  const queue = requiredDeadLetterQueue(env, datasource);
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index] ?? [];
    try {
      await queue.sendBatch(chunk.map((entry) => ({ body: entry.envelope })));
      for (const entry of chunk) entry.item.message.ack();
    } catch (error) {
      for (const pending of chunks.slice(index).flat()) retry(pending.item.message, error);
      return;
    }
  }
  console.error("event-ingest-api raw event deliveries transferred for operator review", {
    datasource,
    classification: outcome.kind,
    reason: outcome.reason,
    rowCount: items.length,
    chunkCount: chunks.length,
  });
}

interface RawFailureEntry {
  readonly item: AdmittedRawEvent;
  readonly envelope: RawEventFailureEnvelope;
  readonly bytes: number;
}

function failureChunks(
  items: readonly AdmittedRawEvent[],
  outcome: { readonly kind: "indeterminate" | "poison"; readonly reason: string },
): RawFailureEntry[][] {
  const chunks: RawFailureEntry[][] = [];
  let current: RawFailureEntry[] = [];
  let bytes = 0;
  for (const item of items) {
    const envelope: RawEventFailureEnvelope = {
      kind: "raw-event-delivery-failure-v1",
      classification: outcome.kind,
      reason: outcome.reason,
      sourceMessageId: item.message.id,
      sourceAttempts: item.message.attempts,
      original: item.envelope,
    };
    const entry = { item, envelope, bytes: byteLength(JSON.stringify(envelope)) };
    if (entry.bytes > DLQ_MAX_MESSAGE_BYTES) {
      throw new Error(`Raw event failure envelope exceeds ${String(DLQ_MAX_MESSAGE_BYTES)} bytes`);
    }
    if (
      current.length > 0 &&
      (current.length >= DLQ_MAX_MESSAGES || bytes + entry.bytes > DLQ_MAX_BATCH_BYTES)
    ) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(entry);
    bytes += entry.bytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
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

function requiredDeadLetterQueue(
  env: Env,
  datasource: RawEventDatasource,
): Queue<Record<string, unknown>> {
  const queue = datasource === "raw_events" ? env.RAW_EVENTS_DLQ : env.RAW_EVALUATIONS_DLQ;
  if (!queue) throw new Error(`${datasource} dead-letter queue binding is unavailable`);
  return queue;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

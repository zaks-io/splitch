import { requirePlatformTarget } from "@splitch/contracts";
import { createIngestPhaseTiming } from "./ingest-phase-timing";
import { queueRetryDelaySeconds } from "./queue-retry";
import {
  type RawEventFailureSource,
  rawFailureChunks,
  requiredRawEventDeadLetterQueue,
} from "./raw-event-dead-letter";
import { admitRawEventPrivacy, completeRawEventPrivacy } from "./raw-event-privacy-delivery";
import {
  parseRawEventEnvelope,
  type RawEventDatasource,
  type RawEventQueueEnvelope,
  rawEventDatasourceForQueue,
} from "./raw-event-queue-envelope";
import {
  emitRawEventBatchSettlement,
  emptyRawEventOutcomeCounts,
  type RawEventOutcomeCounts,
} from "./raw-event-queue-telemetry";
import {
  markRawEventDelivered,
  markRawEventRetryable,
  markRawEventTerminal,
  markRawEventTransferred,
  type RawEventTerminalState,
} from "./raw-event-terminal-state";
import { tinybirdDelivery } from "./tinybird";
import { ndjsonBatches, sendNdjsonBatch } from "./tinybird-microbatch";
import type { Env } from "./types";

interface AdmittedRawEvent extends RawEventFailureSource {
  readonly message: Message<Record<string, unknown>>;
  readonly envelope: RawEventQueueEnvelope;
  readonly deliveryId: string;
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
  const queueDatasource = rawEventDatasourceForQueue(batch.queue);
  const timing = createIngestPhaseTiming(env, {
    route: "raw_queue_settlement",
    stream: queueDatasource,
  });
  const outcomes = emptyRawEventOutcomeCounts();
  try {
    const groups = await timing.measure("admission", () =>
      admitBatch(batch.messages, queueDatasource, env, outcomes),
    );
    await timing.measure("delivery", async () => {
      for (const [datasource, admitted] of groups) {
        await deliverGroup(datasource, admitted, env, outcomes);
      }
    });
  } finally {
    emitRawEventBatchSettlement(timing, batch, queueDatasource, outcomes);
  }
}

async function admitBatch(
  messages: readonly Message<Record<string, unknown>>[],
  queueDatasource: RawEventDatasource,
  env: Env,
  outcomes: RawEventOutcomeCounts,
): Promise<Map<RawEventDatasource, AdmittedRawEvent[]>> {
  const groups = new Map<RawEventDatasource, AdmittedRawEvent[]>();
  await Promise.all(
    messages.map((message) => admitMessage(message, queueDatasource, env, groups, outcomes)),
  );
  return groups;
}

async function admitMessage(
  message: Message<Record<string, unknown>>,
  queueDatasource: RawEventDatasource,
  env: Env,
  groups: Map<RawEventDatasource, AdmittedRawEvent[]>,
  outcomes: RawEventOutcomeCounts,
): Promise<void> {
  let queued: RawEventQueueEnvelope;
  try {
    queued = parseRawEventEnvelope(message.body);
    if (queued.datasource !== queueDatasource) {
      throw new Error(`${queued.datasource} envelope arrived on ${queueDatasource} queue`);
    }
  } catch (error) {
    outcomes.retryable += 1;
    retry(message, error);
    return;
  }
  const deliveryId = `queue:${queued.datasource}:${message.id}`;
  const item = { message, envelope: queued, deliveryId };
  try {
    const privacy = await admitRawEventPrivacy(queued.datasource, queued.row, deliveryId, env);
    if (privacy.kind === "suppressed") {
      outcomes.suppressed += 1;
      return message.ack();
    }
    if (privacy.kind === "delivered") {
      outcomes.delivered += 1;
      await settleCompletedAdmissions([item], env, (completed) => completed.message.ack());
      return;
    }
    if (privacy.kind === "terminal") {
      outcomes[privacy.state.classification] += 1;
      return resumeTerminalFailure(item, privacy.state, env);
    }
  } catch (error) {
    outcomes.retryable += 1;
    await cleanupFailedAdmission(item, env, error);
    return;
  }
  const group = groups.get(queued.datasource) ?? [];
  group.push(item);
  groups.set(queued.datasource, group);
}

async function cleanupFailedAdmission(
  item: AdmittedRawEvent,
  env: Env,
  error: unknown,
): Promise<void> {
  try {
    await completeAdmission(item, env);
    retry(item.message, error);
  } catch (cleanupError) {
    retry(
      item.message,
      new AggregateError([error, cleanupError], "privacy admission cleanup failed"),
    );
  }
}

async function deliverGroup(
  datasource: RawEventDatasource,
  admitted: readonly AdmittedRawEvent[],
  env: Env,
  outcomes: RawEventOutcomeCounts,
): Promise<void> {
  const delivery = tinybirdDelivery(env, datasource);
  if (!delivery.ok) {
    outcomes.retryable += admitted.length;
    await recordThenComplete(admitted, env, markRawEventRetryable, (item) =>
      retry(item.message, new Error(delivery.error.message)),
    );
    return;
  }
  for (const microbatch of ndjsonBatches(admitted, (item) => item.envelope.row)) {
    const outcome = await sendNdjsonBatch(microbatch.body, microbatch.items.length, delivery.value);
    outcomes[outcome.kind] += microbatch.items.length;
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
    await recordThenComplete(items, env, markRawEventDelivered, (item) => item.message.ack());
    return;
  }
  if (outcome.kind === "retryable") {
    await recordThenComplete(items, env, markRawEventRetryable, (item) =>
      retryDelivery(item, outcome),
    );
    return;
  }
  await transferTerminalFailure(datasource, items, outcome, env);
}

async function completeAdmission(item: AdmittedRawEvent, env: Env): Promise<void> {
  await completeRawEventPrivacy(item.envelope.datasource, item.envelope.row, item.deliveryId, env);
}

async function settleCompletedAdmissions(
  items: readonly AdmittedRawEvent[],
  env: Env,
  settle: (item: AdmittedRawEvent) => void,
): Promise<void> {
  const completions = await Promise.allSettled(items.map((item) => completeAdmission(item, env)));
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const completion = completions[index];
    if (!item || !completion) continue;
    if (completion.status === "fulfilled") settle(item);
    else retry(item.message, completion.reason);
  }
}

async function recordThenComplete(
  items: readonly AdmittedRawEvent[],
  env: Env,
  record: (env: Env, row: Record<string, unknown>, deliveryId: string) => Promise<void>,
  settle: (item: AdmittedRawEvent) => void,
): Promise<void> {
  const recorded = await recordItems(items, (item) =>
    record(env, item.envelope.row, item.deliveryId),
  );
  await settleCompletedAdmissions(recorded, env, settle);
}

async function recordItems(
  items: readonly AdmittedRawEvent[],
  record: (item: AdmittedRawEvent) => Promise<void>,
): Promise<AdmittedRawEvent[]> {
  const outcomes = await Promise.allSettled(items.map(record));
  const recorded: AdmittedRawEvent[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const outcome = outcomes[index];
    if (!item || !outcome) continue;
    if (outcome.status === "fulfilled") recorded.push(item);
    else retry(item.message, outcome.reason);
  }
  return recorded;
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
  const terminal = { classification: outcome.kind, reason: outcome.reason } as const;
  const marked = await recordItems(items, (item) =>
    markRawEventTerminal(env, item.envelope.row, item.deliveryId, terminal),
  );
  const chunks = rawFailureChunks(marked, terminal);
  const queue = requiredRawEventDeadLetterQueue(env, datasource);
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index] ?? [];
    try {
      await queue.sendBatch(chunk.map((entry) => ({ body: entry.envelope })));
      const transferred = await recordItems(
        chunk.map((entry) => entry.item),
        (item) => markRawEventTransferred(env, item.envelope.row, item.deliveryId),
      );
      await settleCompletedAdmissions(transferred, env, (item) => item.message.ack());
    } catch (error) {
      for (const pending of chunks.slice(index).flat()) retry(pending.item.message, error);
      return;
    }
  }
  console.error("event-ingest-api raw event deliveries transferred for operator review", {
    datasource,
    classification: outcome.kind,
    reason: outcome.reason,
    rowCount: marked.length,
    chunkCount: chunks.length,
  });
}

async function resumeTerminalFailure(
  item: AdmittedRawEvent,
  terminal: RawEventTerminalState,
  env: Env,
): Promise<void> {
  if (!terminal.transferred) {
    const entry = rawFailureChunks([item], terminal)[0]?.[0];
    if (!entry) throw new Error("Raw event terminal failure envelope is unavailable");
    try {
      await requiredRawEventDeadLetterQueue(env, item.envelope.datasource).send(entry.envelope);
      await markRawEventTransferred(env, item.envelope.row, item.deliveryId);
    } catch (error) {
      retry(item.message, error);
      return;
    }
  }
  await settleCompletedAdmissions([item], env, (completed) => completed.message.ack());
}

function retry(message: Message<Record<string, unknown>>, error: unknown): void {
  console.error("event-ingest-api raw event queue admission failed", {
    queueMessageId: message.id,
    attempts: message.attempts,
    errorMessage: error instanceof Error ? error.message : "non-error rejection",
  });
  message.retry({ delaySeconds: queueRetryDelaySeconds(message.attempts, message.id) });
}

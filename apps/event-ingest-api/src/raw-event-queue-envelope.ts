import type { Env } from "./types";

export type RawEventDatasource = "raw_events" | "raw_evaluations";

export interface RawEventQueueEnvelope extends Record<string, unknown> {
  readonly kind: "raw-event-delivery-v1";
  readonly datasource: RawEventDatasource;
  readonly row: Record<string, unknown>;
}

/** Leaves enough Queue-message headroom for the original row plus failure metadata in the DLQ. */
export const RAW_EVENT_QUEUE_MAX_MESSAGE_BYTES = 64_000;

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

export function parseRawEventEnvelope(value: Record<string, unknown>): RawEventQueueEnvelope {
  if (
    value.kind !== "raw-event-delivery-v1" ||
    (value.datasource !== "raw_events" && value.datasource !== "raw_evaluations") ||
    !isRecord(value.row)
  ) {
    throw new Error("raw event queue envelope is invalid");
  }
  assertEnvelopeSize(value);
  return value as RawEventQueueEnvelope;
}

export function rawEventDatasourceForQueue(queue: string): RawEventDatasource {
  if (queue.includes("raw-evaluations")) return "raw_evaluations";
  if (queue.includes("raw-events")) return "raw_events";
  throw new Error(`unknown raw event queue ${queue}`);
}

function envelope(
  datasource: RawEventDatasource,
  row: Record<string, unknown>,
): RawEventQueueEnvelope {
  const value = { kind: "raw-event-delivery-v1", datasource, row } as const;
  assertEnvelopeSize(value);
  return value;
}

function assertEnvelopeSize(value: Record<string, unknown>): void {
  const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (bytes > RAW_EVENT_QUEUE_MAX_MESSAGE_BYTES) {
    throw new Error(
      `raw event queue envelope exceeds ${String(RAW_EVENT_QUEUE_MAX_MESSAGE_BYTES)} bytes`,
    );
  }
}

function requiredQueue(env: Env, datasource: RawEventDatasource): Queue<Record<string, unknown>> {
  const queue = datasource === "raw_events" ? env.RAW_EVENTS_QUEUE : env.RAW_EVALUATIONS_QUEUE;
  if (!queue) throw new Error(`${datasource} queue binding is unavailable`);
  return queue;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

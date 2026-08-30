import type { RawEventDatasource } from "./raw-event-queue-envelope";

export interface RawEventFailureSource {
  readonly message: Message<Record<string, unknown>>;
  readonly envelope: {
    readonly kind: "raw-event-delivery-v1";
    readonly datasource: RawEventDatasource;
    readonly row: Record<string, unknown>;
  };
  readonly deliveryId: string;
}

interface RawEventFailureEnvelope extends Record<string, unknown> {
  readonly kind: "raw-event-delivery-failure-v1";
  readonly classification: "indeterminate" | "poison";
  readonly reason: string;
  readonly sourceMessageId: string;
  readonly sourceAttempts: number;
  readonly original: RawEventFailureSource["envelope"];
}

export interface RawFailureEntry {
  readonly item: RawEventFailureSource;
  readonly envelope: RawEventFailureEnvelope;
  readonly bytes: number;
}

const MAX_MESSAGES = 100;
const MAX_BATCH_BYTES = 240_000;
const MAX_MESSAGE_BYTES = 120_000;

export function rawFailureChunks(
  items: readonly RawEventFailureSource[],
  outcome: { readonly classification: "indeterminate" | "poison"; readonly reason: string },
): RawFailureEntry[][] {
  const chunks: RawFailureEntry[][] = [];
  let current: RawFailureEntry[] = [];
  let bytes = 0;
  for (const item of items) {
    const envelope: RawEventFailureEnvelope = {
      kind: "raw-event-delivery-failure-v1",
      classification: outcome.classification,
      reason: outcome.reason,
      sourceMessageId: item.message.id,
      sourceAttempts: item.message.attempts,
      original: item.envelope,
    };
    const entry = { item, envelope, bytes: byteLength(JSON.stringify(envelope)) };
    if (entry.bytes > MAX_MESSAGE_BYTES) {
      throw new Error(`Raw event failure envelope exceeds ${String(MAX_MESSAGE_BYTES)} bytes`);
    }
    if (
      current.length > 0 &&
      (current.length >= MAX_MESSAGES || bytes + entry.bytes > MAX_BATCH_BYTES)
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

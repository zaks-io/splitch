/**
 * The Metric Event queue consumer wired to real privacy authorities and real
 * outbox objects, so a test sees the same admission, write-ahead, and
 * dead-letter behavior production does.
 */
import { vi } from "vitest";
import { EntityMetricPrivacyDurableObject } from "./entity-metric-privacy-store";
import { MetricEventOutboxDurableObject } from "./metric-event-outbox";
import type { Env } from "./types";

type Row = Record<string, unknown>;

export interface QueueFixture {
  readonly env: Env;
  /** The dead-letter producer, so a test can see exactly what was copied there. */
  readonly dlq: { sendBatch: ReturnType<typeof vi.fn> };
  seal(row: Row): Promise<void>;
  deliveryState(dedupKey: string): string | undefined;
}

export function makeQueueFixture(): QueueFixture {
  const dlq = { send: vi.fn(), sendBatch: vi.fn() };
  const queue = { send: vi.fn(), sendBatch: vi.fn() };
  const reconciliation = { send: vi.fn(), sendBatch: vi.fn() };
  const env = {
    SPLITCH_PLATFORM_TARGET: "local",
    TINYBIRD_API_URL: "https://tinybird.test",
    TINYBIRD_INGEST_TOKEN: "test-token",
    EVALUATION_PRIVACY_SALT: "test-privacy-salt",
    METRIC_EVENTS_QUEUE: queue,
    METRIC_EVENTS_DLQ: dlq,
    METRIC_EVENTS_RECONCILIATION_QUEUE: reconciliation,
    EVALUATION_COMMIT_OUTBOX: emptyEvaluationOutbox(),
  } as unknown as Env;
  const outboxState = new Map<string, Map<string, unknown>>();
  env.METRIC_EVENT_OUTBOX = namespace((name) => {
    const values = new Map<string, unknown>();
    outboxState.set(name, values);
    return new MetricEventOutboxDurableObject(
      { storage: memoryStorage(values) } as DurableObjectState,
      env,
    );
  });
  env.ENTITY_METRIC_PRIVACY = namespace(
    () =>
      new EntityMetricPrivacyDurableObject(
        { storage: memoryStorage(new Map()) } as DurableObjectState,
        env,
      ),
  );

  return {
    env,
    dlq,
    /** Seals a row in its outbox exactly as intake does, so the queue message has a record. */
    async seal(row: Row): Promise<void> {
      const outbox = env.METRIC_EVENT_OUTBOX;
      if (!outbox) throw new Error("fixture outbox is missing");
      const response = await outbox
        .get(outbox.idFromName(String(row.dedup_key)))
        .fetch("https://metric-event-outbox.local/claim", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            fingerprint: `fingerprint:${String(row.event_id)}`,
            eventDefinitionId: String(row.event_definition_id),
            eventDefinitionVersionId: String(row.event_definition_version_id),
            row,
            queued: false,
            deleted: false,
          }),
        });
      if (!response.ok) throw new Error(`fixture seal returned HTTP ${response.status}`);
    },
    /** The durable write-ahead state for a row, read without disturbing it. */
    deliveryState(dedupKey: string): string | undefined {
      const claim = outboxState.get(dedupKey)?.get("metric-event-claim") as
        | { delivery?: { state?: string }; deleted?: boolean }
        | undefined;
      return claim?.delivery?.state ?? (claim?.deleted === true ? "deleted" : undefined);
    },
  };
}

/** One Durable Object instance per name, created on first use. */
function namespace<T extends { fetch(request: Request): Promise<Response> }>(
  create: (name: string) => T,
) {
  const objects = new Map<string, T>();
  return {
    idFromName: (name: string) => name as unknown as DurableObjectId,
    get: (id: DurableObjectId) => {
      const name = String(id);
      const existing = objects.get(name) ?? create(name);
      objects.set(name, existing);
      return {
        fetch: (input: RequestInfo | URL, init?: RequestInit) =>
          existing.fetch(new Request(String(input), init)),
      };
    },
  };
}

function memoryStorage(values: Map<string, unknown>): DurableObjectStorage {
  return {
    get: async <T>(key: string) => values.get(key) as T | undefined,
    put: async (key: string, value: unknown) => void values.set(key, structuredClone(value)),
    delete: async (key: string | string[]) =>
      Array.isArray(key)
        ? key.reduce((count, item) => count + Number(values.delete(item)), 0)
        : values.delete(key),
    setAlarm: async () => {},
    list: async <T>({ prefix }: { prefix: string }) =>
      new Map(
        [...values.entries()].filter(([key]) => key.startsWith(prefix)) as Array<[string, T]>,
      ),
  } as unknown as DurableObjectStorage;
}

function emptyEvaluationOutbox() {
  return {
    privacyExport: async () => [],
    privacyDelete: async () => 0,
    privacyDeleteAll: async () => "evaluation-commit-outbox-purged-v1" as const,
  };
}

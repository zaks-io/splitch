import { vi } from "vitest";
import { EntityMetricPrivacyDurableObject } from "./entity-metric-privacy-store";
import worker from "./index";
import type { Env } from "./types";

export interface RawEventQueueTestEnv {
  readonly __queuedRows: Record<string, unknown>[];
}

type TestMock = ReturnType<typeof vi.fn>;

export type RawEventTestMessage = Omit<Message<Record<string, unknown>>, "attempts"> & {
  attempts: number;
  readonly ack: TestMock;
  readonly retry: TestMock;
};

interface RawEventTestQueue {
  readonly send: TestMock;
  readonly sendBatch: TestMock;
  readonly metrics: TestMock;
}

export function rawEventQueueBindings() {
  const queuedRows: Record<string, unknown>[] = [];
  const queue = {
    send: vi.fn(async (body: Record<string, unknown>) => {
      queuedRows.push(queueRow(body));
      return queueResult();
    }),
    sendBatch: vi.fn(async (messages: Iterable<{ body: Record<string, unknown> }>) => {
      for (const message of messages) queuedRows.push(queueRow(message.body));
      return queueResult();
    }),
    metrics: vi.fn(async () => queueResult().metadata.metrics),
  };
  return {
    RAW_EVENTS_QUEUE: queue,
    RAW_EVALUATIONS_QUEUE: queue,
    __queuedRows: queuedRows,
  };
}

export function captureQueuedResponse<Context, Fetch>(
  ctx: Context,
  fetch: Fetch,
  response: Response,
  env: RawEventQueueTestEnv,
  queuedStart: number,
) {
  return { ctx, fetch, response, rows: env.__queuedRows.slice(queuedStart) };
}

export function rawEventMessage(id: string, datasource = "raw_events"): RawEventTestMessage {
  return {
    id,
    timestamp: new Date("2026-08-30T00:00:00.000Z"),
    attempts: 1,
    body: {
      kind: "raw-event-delivery-v1",
      datasource,
      row: {
        app_id: "app_1",
        environment_id: "env_1",
        id_type: "user",
        targeting_key_hash: "app-v1:target",
        entity_family_hash: "app-v1:family",
        server_received_at: "2026-08-30T00:00:00.000Z",
        dedup_key: `sha256:${id}`,
      },
    },
    ack: vi.fn(),
    retry: vi.fn(),
  } satisfies Message<Record<string, unknown>>;
}

export async function deliverRawEventMessages(
  queue: string,
  messages: readonly RawEventTestMessage[],
  overrides: Partial<Env> = {},
): Promise<{ rawEventsDlq: RawEventTestQueue; rawEvaluationsDlq: RawEventTestQueue }> {
  if (!worker.queue) throw new Error("queue handler is unavailable");
  const rawEventsDlq = { send: vi.fn(), sendBatch: vi.fn(), metrics: vi.fn() };
  const rawEvaluationsDlq = { send: vi.fn(), sendBatch: vi.fn(), metrics: vi.fn() };
  await worker.queue(
    {
      queue,
      messages,
      metadata: { metrics: { backlogCount: messages.length, backlogBytes: 1_024 } },
      ackAll: vi.fn(),
      retryAll: vi.fn(),
    },
    {
      SPLITCH_PLATFORM_TARGET: "local",
      TINYBIRD_API_URL: "https://tinybird.test",
      TINYBIRD_INGEST_TOKEN: "test-token",
      RAW_EVENTS_DLQ: rawEventsDlq,
      RAW_EVALUATIONS_DLQ: rawEvaluationsDlq,
      ...overrides,
    } as Env,
    {} as ExecutionContext,
  );
  return { rawEventsDlq, rawEvaluationsDlq };
}

export function rawEventPrivacyNamespace(lostPath?: string, responsesToLose = 1) {
  const objects = new Map<string, EntityMetricPrivacyDurableObject>();
  let remainingLosses = lostPath === undefined ? 0 : responsesToLose;
  let namespace!: Env["ENTITY_METRIC_PRIVACY"];
  const env = () =>
    ({
      SPLITCH_PLATFORM_TARGET: "production",
      TINYBIRD_API_URL: "https://tinybird.test",
      TINYBIRD_INGEST_TOKEN: "test-token",
      ENTITY_METRIC_PRIVACY: namespace,
      EVALUATION_COMMIT_OUTBOX: {},
      METRIC_EVENT_OUTBOX: {},
    }) as Env;
  namespace = {
    idFromName: (name: string) => name as unknown as DurableObjectId,
    get: (id: DurableObjectId) => ({
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const name = String(id);
        let object = objects.get(name);
        if (!object) {
          object = new EntityMetricPrivacyDurableObject(
            { storage: memoryStorage() } as DurableObjectState,
            env(),
          );
          objects.set(name, object);
        }
        const response = await object.fetch(new Request(String(input), init));
        if (remainingLosses > 0 && new URL(String(input)).pathname === lostPath) {
          remainingLosses -= 1;
          throw new Error("admission response lost");
        }
        return response;
      },
    }),
  };
  return {
    namespace,
    async alarm(name: string) {
      const object = objects.get(name);
      if (!object) throw new Error(`privacy object ${name} is unavailable`);
      await object.alarm();
    },
    fetch(name: string, path: string, body: unknown) {
      return namespace.get(namespace.idFromName(name)).fetch(`https://privacy.test${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    },
  };
}

function queueRow(body: Record<string, unknown>): Record<string, unknown> {
  const row = body.row;
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    throw new Error("expected raw queue envelope");
  }
  return row as Record<string, unknown>;
}

function queueResult() {
  return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
}

function memoryStorage(): DurableObjectStorage {
  const values = new Map<string, unknown>();
  let alarm: number | null = null;
  return {
    get: async <T>(key: string) => values.get(key) as T | undefined,
    put: async (key: string, value: unknown) => void values.set(key, structuredClone(value)),
    delete: async (key: string | string[]) =>
      Array.isArray(key)
        ? key.reduce((count, item) => count + Number(values.delete(item)), 0)
        : values.delete(key),
    list: async <T>({ prefix }: { prefix: string }) =>
      new Map(
        [...values.entries()].filter(([key]) => key.startsWith(prefix)) as Array<[string, T]>,
      ),
    getAlarm: async () => alarm,
    setAlarm: async (scheduledTime: number | Date) => {
      alarm = typeof scheduledTime === "number" ? scheduledTime : scheduledTime.getTime();
    },
    deleteAlarm: async () => {
      alarm = null;
    },
    deleteAll: async () => {
      values.clear();
    },
  } as unknown as DurableObjectStorage;
}

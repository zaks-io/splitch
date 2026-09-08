import { expect, vi } from "vitest";
import { EntityMetricPrivacyDurableObject } from "./entity-metric-privacy-store";
import type { Env } from "./types";

export const ENTRY = {
  dedupKey: "sha256:event-1",
  fingerprint: "sha256:fingerprint-1",
  eventDefinitionId: "event_definition_checkout",
  eventDefinitionVersionId: "event_definition_checkout_v1",
  targetingKeyHash: "app-v1:aaaaaaaa",
  serverReceivedAt: "2026-08-07T00:00:00.000Z",
};

export const EVALUATION_ENTRY = {
  commitIdentity: "a".repeat(64),
  eventId: "event-exposure-1",
  serverReceivedAt: ENTRY.serverReceivedAt,
};

export function makeEntityMetricPrivacyStoreFixture() {
  const storage = new Map<string, unknown>();
  let blockedGet: { key: string; started: () => void; wait: Promise<void> } | undefined;
  const outboxFetch = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit, id?: string) => {
    const path = new URL(String(input)).pathname;
    if (path === "/export") {
      return Response.json({
        deleted: false,
        row: {
          event_id: id?.replace(/^sha256:/u, "") ?? "event-1",
          targeting_key_hash: ENTRY.targetingKeyHash,
        },
      });
    }
    if (path === "/suppress") {
      return Response.json({ deleted: true, proof: "metric-event-outbox-redacted-v1" });
    }
    return new Response("not found", { status: 404 });
  });
  const ctx = memoryDurableObjectState(
    storage,
    () => blockedGet,
    (next) => {
      blockedGet = next;
    },
  );
  const evaluationOutbox = {
    lookup: vi.fn(async () => null),
    commit: vi.fn(async () => {
      throw new Error("not used");
    }),
    activate: vi.fn(async () => {
      throw new Error("not used");
    }),
    deliver: vi.fn(async () => {
      throw new Error("not used");
    }),
    acknowledge: vi.fn(async () => undefined),
    privacyExport: vi.fn(async (_identity: string, eventIds: readonly string[]) =>
      eventIds.map((eventId) => ({ event_id: eventId, source: "evaluation-commit" })),
    ),
    privacyDelete: vi.fn(async () => 1),
    privacyDeleteAll: vi.fn(async () => "evaluation-commit-outbox-purged-v1" as const),
  };
  const env = {
    SPLITCH_PLATFORM_TARGET: "production",
    TINYBIRD_API_URL: "https://tinybird.test",
    TINYBIRD_INGEST_TOKEN: "test-token",
    METRIC_EVENT_OUTBOX: {
      idFromName: (name: string) => name as unknown as DurableObjectId,
      get: (id: DurableObjectId) => ({
        fetch: (input: RequestInfo | URL, init?: RequestInit) =>
          outboxFetch(input, init, id as unknown as string),
      }),
    },
    EVALUATION_COMMIT_OUTBOX: evaluationOutbox,
  } as Env;
  let object = new EntityMetricPrivacyDurableObject(ctx, env);
  return {
    outboxFetch,
    evaluationOutbox,
    persistedState() {
      return structuredClone([...storage.entries()]);
    },
    pauseNextGet(key: string) {
      let release!: () => void;
      let started!: () => void;
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      const startedPromise = new Promise<void>((resolve) => {
        started = resolve;
      });
      blockedGet = { key, started, wait };
      return { started: startedPromise, release };
    },
    restart() {
      object = new EntityMetricPrivacyDurableObject(ctx, env);
    },
    request(path: string, body: unknown) {
      return object.fetch(
        new Request(`https://entity-privacy.local${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    },
    async post(path: string, body: unknown) {
      const response = await this.request(path, body);
      expect(response.status).toBe(200);
      return response.json();
    },
    async get(path: string) {
      const response = await object.fetch(new Request(`https://entity-privacy.local${path}`));
      expect(response.status).toBe(200);
      return response.json();
    },
  };
}

function memoryDurableObjectState(
  storage: Map<string, unknown>,
  blocked: () => { key: string; started: () => void; wait: Promise<void> } | undefined,
  setBlocked: (value: undefined) => void,
): DurableObjectState {
  return {
    storage: {
      async get<T>(key: string) {
        const gate = blocked();
        if (gate?.key === key) {
          setBlocked(undefined);
          gate.started();
          await gate.wait;
        }
        return storage.has(key) ? (structuredClone(storage.get(key)) as T) : undefined;
      },
      async put(key: string, value: unknown) {
        storage.set(key, structuredClone(value));
      },
      async list<T>({
        prefix,
        startAfter,
        limit,
      }: {
        prefix: string;
        startAfter?: string;
        limit?: number;
      }) {
        return new Map(
          [...storage.entries()]
            .filter(([key]) => key.startsWith(prefix))
            .filter(([key]) => startAfter === undefined || key > startAfter)
            .sort(([left], [right]) => left.localeCompare(right))
            .slice(0, limit)
            .map(([key, value]) => [key, structuredClone(value) as T]),
        );
      },
      async delete(keys: string | string[]) {
        if (Array.isArray(keys)) {
          return keys.reduce((count, key) => count + Number(storage.delete(key)), 0);
        }
        return storage.delete(keys);
      },
    },
  } as unknown as DurableObjectState;
}

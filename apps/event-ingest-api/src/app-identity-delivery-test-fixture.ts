/**
 * The App-identity inventory wired to a real Entity authority, so a test can
 * exercise the App -> Entity -> Tinybird path the delivery lock guards.
 */
import { expect } from "vitest";
import { EntityMetricPrivacyDurableObject } from "./entity-metric-privacy-store";
import type { Env } from "./types";

export function makeEntityDeliveryFixture() {
  const appStorage = memoryStorage();
  const entityStorage = memoryStorage();
  let entity!: EntityMetricPrivacyDurableObject;
  const env = {
    SPLITCH_PLATFORM_TARGET: "production",
    TINYBIRD_API_URL: "https://tinybird.test",
    TINYBIRD_INGEST_TOKEN: "test-token",
    EVALUATION_COMMIT_OUTBOX: emptyEvaluationOutbox(),
    METRIC_EVENT_OUTBOX: {
      idFromName: () => ({}) as DurableObjectId,
      get: () => ({ fetch: async () => new Response("not found", { status: 404 }) }),
    },
    ENTITY_METRIC_PRIVACY: {
      idFromName: (name: string) => name as unknown as DurableObjectId,
      get: () => ({
        fetch: (input: RequestInfo | URL, init?: RequestInit) =>
          entity.fetch(new Request(String(input), init)),
      }),
    },
  } as Env;
  entity = new EntityMetricPrivacyDurableObject(
    { storage: entityStorage } as DurableObjectState,
    env,
  );
  const app = new EntityMetricPrivacyDurableObject(
    { storage: appStorage } as DurableObjectState,
    env,
  );
  return { post: postTo(app) };
}

function memoryStorage(): DurableObjectStorage {
  const values = new Map<string, unknown>();
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
  } as unknown as DurableObjectStorage;
}

function postTo(object: EntityMetricPrivacyDurableObject) {
  return async (path: string, body: unknown) => {
    const response = await object.fetch(
      new Request(`https://entity-privacy.local${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    expect(response.status).toBe(200);
    return response.json();
  };
}

function emptyEvaluationOutbox() {
  return {
    lookup: async () => null,
    commit: async () => {
      throw new Error("not used");
    },
    deliver: async () => {
      throw new Error("not used");
    },
    acknowledge: async () => undefined,
    privacyExport: async () => [],
    privacyDelete: async () => 0,
    privacyDeleteAll: async () => "evaluation-commit-outbox-purged-v1" as const,
  };
}

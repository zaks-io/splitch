import { afterEach, describe, expect, it, vi } from "vitest";
import { EntityMetricPrivacyDurableObject } from "./entity-metric-privacy-store";
import type { Env } from "./types";

afterEach(() => vi.unstubAllGlobals());

describe("App identity delivery generation", () => {
  it("blocks Evaluation usage delivery while reset suppression is durable", async () => {
    const fixture = makeFixture();
    const append = vi.fn(async () => new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", append);
    const row = { app_id: "app_1", identity_version: "app-v1", dedup_key: "usage" };

    await expect(deliver(fixture, "app-v1", row)).resolves.toEqual({ suppressed: false });
    await fixture.post("/reset-app", {
      appId: "app_1",
      resetId: "reset_usage",
      currentVersion: "app-v1",
    });
    await expect(deliver(fixture, "app-v1", row)).resolves.toEqual({ suppressed: true });
    expect(append).toHaveBeenCalledTimes(1);
  });

  it("releases only the durably activated replacement generation", async () => {
    const fixture = makeFixture();
    const append = vi.fn(async () => new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", append);
    const oldRow = { app_id: "app_1", identity_version: "app-v1", dedup_key: "old" };
    await deliver(fixture, "app-v1", oldRow);
    await fixture.post("/reset-app", {
      appId: "app_1",
      resetId: "reset_generation",
      currentVersion: "app-v1",
    });
    const newRow = { ...oldRow, identity_version: "app-v2", dedup_key: "new" };
    await expect(deliver(fixture, "app-v2", newRow)).resolves.toEqual({ suppressed: true });

    await fixture.post("/complete-reset", {
      resetId: "reset_generation",
      nextVersion: "app-v2",
    });
    await expect(deliver(fixture, "app-v1", oldRow)).resolves.toEqual({ suppressed: true });
    await expect(deliver(fixture, "app-v2", newRow)).resolves.toEqual({ suppressed: false });
    expect(append).toHaveBeenCalledTimes(2);
  });

  it("holds the App authority until the Entity append finishes, then resets and purges it", async () => {
    const fixture = makeEntityDeliveryFixture();
    let releaseAppend!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        markStarted();
        await gate;
        return new Response(null, { status: 202 });
      }),
    );
    const row = {
      app_id: "app_1",
      id_type: "user",
      identity_version: "app-v1",
      targeting_key_hash: "app-v1:entity",
      entity_family_hash: "app-v1:family",
      server_received_at: "2026-08-07T00:00:00.000Z",
    };
    const delivery = fixture.post("/deliver-entity-row", {
      appId: "app_1",
      idType: "user",
      identityVersion: "app-v1",
      entityFamilyHash: "app-v1:family",
      datasource: "raw_events",
      row,
    });
    await started;
    let resetSettled = false;
    const reset = fixture
      .post("/reset-app", {
        appId: "app_1",
        resetId: "reset_entity_race",
        currentVersion: "app-v1",
      })
      .finally(() => {
        resetSettled = true;
      });
    await Promise.resolve();
    expect(resetSettled).toBe(false);
    releaseAppend();
    await expect(delivery).resolves.toEqual({ suppressed: false });
    await expect(reset).resolves.toEqual({
      proof: "event-delivery:entities=1;evaluation_commits=0",
    });
    await expect(
      fixture.post("/deliver-entity-row", {
        appId: "app_1",
        idType: "user",
        identityVersion: "app-v1",
        entityFamilyHash: "app-v1:family",
        datasource: "raw_events",
        row,
      }),
    ).resolves.toEqual({ suppressed: true });
  });

  it("rejects an Entity row relabeled as the active generation", async () => {
    const fixture = makeEntityDeliveryFixture();
    await expect(
      fixture.post("/deliver-entity-row", {
        appId: "app_1",
        idType: "user",
        identityVersion: "app-v2",
        entityFamilyHash: "app-v1:family",
        datasource: "raw_events",
        row: {
          app_id: "app_1",
          id_type: "user",
          identity_version: "app-v1",
          targeting_key_hash: "app-v1:entity",
          entity_family_hash: "app-v1:family",
          server_received_at: "2026-08-07T00:00:00.000Z",
        },
      }),
    ).rejects.toThrow("Entity identity delivery input is invalid");
  });
});

function deliver(
  fixture: ReturnType<typeof makeFixture>,
  identityVersion: string,
  row: Record<string, unknown>,
) {
  return fixture.post("/deliver-app-row", {
    appId: "app_1",
    identityVersion,
    datasource: "raw_evaluations",
    row,
  });
}

function makeFixture() {
  const values = new Map<string, unknown>();
  const storage = {
    get: async <T>(key: string) => values.get(key) as T | undefined,
    put: async (key: string, value: unknown) => {
      values.set(key, structuredClone(value));
    },
    delete: async (key: string | string[]) => {
      if (Array.isArray(key))
        return key.reduce((count, item) => count + Number(values.delete(item)), 0);
      return values.delete(key);
    },
    list: async <T>({ prefix }: { prefix: string }) =>
      new Map(
        [...values.entries()].filter(([key]) => key.startsWith(prefix)) as Array<[string, T]>,
      ),
  } as unknown as DurableObjectStorage;
  const object = new EntityMetricPrivacyDurableObject(
    { storage } as DurableObjectState,
    {
      SPLITCH_PLATFORM_TARGET: "production",
      TINYBIRD_API_URL: "https://tinybird.test",
      TINYBIRD_INGEST_TOKEN: "test-token",
      EVALUATION_COMMIT_OUTBOX: {
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
        privacyDeleteAll: async () => "evaluation-commit-outbox-purged-v1",
      },
    } as Env,
  );
  return {
    async post(path: string, body: unknown) {
      const response = await object.fetch(
        new Request(`https://entity-privacy.local${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
      expect(response.status).toBe(200);
      return response.json();
    },
  };
}

function makeEntityDeliveryFixture() {
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

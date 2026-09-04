import { describe, expect, it, vi } from "vitest";
import {
  METRIC_APP_ID,
  makeMetricEventFixture,
  metricEventBody,
  sendMetricEvent,
} from "./metric-event.test-fixture";

describe("Metric Event ingest hot-path concurrency", () => {
  it("looks up an existing Event while Entity identity is resolving", async () => {
    const fixture = await makeMetricEventFixture();
    const configStore = fixture.env.CONFIG_STORE;
    const outbox = fixture.env.METRIC_EVENT_OUTBOX;
    if (!configStore || !outbox) throw new Error("Metric Event fixture bindings are missing");
    let releaseIdentity: (() => void) | undefined;
    const identity = new Promise<void>((resolve) => {
      releaseIdentity = resolve;
    });
    let identityStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      identityStarted = resolve;
    });
    let lookupCalls = 0;
    const env = {
      ...fixture.env,
      CONFIG_STORE: {
        async get(key: string) {
          if (key === `app:${METRIC_APP_ID}:entity-identity`) {
            identityStarted?.();
            await identity;
          }
          return configStore.get(key, "text");
        },
        put(key: string, value: string) {
          return configStore.put(key, value);
        },
      } as KVNamespace,
      METRIC_EVENT_OUTBOX: {
        idFromName: outbox.idFromName.bind(outbox),
        get(id: DurableObjectId) {
          const stub = outbox.get(id);
          return {
            fetch(input: RequestInfo | URL, init?: RequestInit) {
              if ((init?.method ?? (input instanceof Request ? input.method : "GET")) === "GET") {
                lookupCalls += 1;
              }
              return stub.fetch(input, init);
            },
          };
        },
      },
    };

    const response = sendMetricEvent({ ...fixture, env }, metricEventBody());
    await started;
    try {
      await vi.waitFor(() => expect(lookupCalls).toBe(1));
    } finally {
      releaseIdentity?.();
    }

    expect((await response).status).toBe(202);
  });

  it("does not claim an existing Event when Entity identity resolution fails", async () => {
    const fixture = await makeMetricEventFixture();
    const configStore = fixture.env.CONFIG_STORE;
    if (!configStore) throw new Error("Metric Event fixture CONFIG_STORE is missing");
    const methods: string[] = [];
    let lookupStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      lookupStarted = resolve;
    });
    const env = {
      ...fixture.env,
      CONFIG_STORE: {
        async get(key: string) {
          if (key === `app:${METRIC_APP_ID}:entity-identity`) {
            await started;
            throw new Error("Entity identity unavailable");
          }
          return configStore.get(key, "text");
        },
        put(key: string, value: string) {
          return configStore.put(key, value);
        },
      } as KVNamespace,
      METRIC_EVENT_OUTBOX: {
        idFromName(name: string) {
          return name as unknown as DurableObjectId;
        },
        get() {
          return {
            fetch(input: RequestInfo | URL, init?: RequestInit) {
              methods.push(init?.method ?? (input instanceof Request ? input.method : "GET"));
              lookupStarted?.();
              return new Promise<Response>(() => {});
            },
          };
        },
      },
    };

    await expect(sendMetricEvent({ ...fixture, env }, metricEventBody())).rejects.toThrow(
      "Entity identity unavailable",
    );
    expect(methods).toEqual(["GET"]);
  });
});

describe("Metric Event replay lookup failures", () => {
  it("fails closed when the concurrent outbox lookup fails", async () => {
    const fixture = await makeMetricEventFixture();
    const env = {
      ...fixture.env,
      METRIC_EVENT_OUTBOX: {
        idFromName(name: string) {
          return name as unknown as DurableObjectId;
        },
        get() {
          return {
            async fetch() {
              throw new Error("outbox unavailable");
            },
          };
        },
      },
    };

    const response = await sendMetricEvent({ ...fixture, env }, metricEventBody());

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      message: "Metric Event outbox is unavailable",
    });
  });
});

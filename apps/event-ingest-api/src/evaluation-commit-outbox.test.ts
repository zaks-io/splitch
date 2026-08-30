import { describe, expect, it, vi } from "vitest";
import { EvaluationCommitOutboxDurableObject } from "./evaluation-commit-outbox";
import type { Env } from "./types";

const IDENTITY = "a".repeat(64);

describe("Evaluation commit outbox privacy", () => {
  it("exports and redacts only the selected Entity exposure while retaining usage", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-28T00:00:00.000Z"));
    const object = new EvaluationCommitOutboxDurableObject(durableState());
    await post(object, "/commit", {
      identity: IDENTITY,
      payload: {
        usage: { idempotencyKey: "evaluation-1" },
        exposureRows: [
          { event_id: "event-a", entity_family_hash: "family-a" },
          { event_id: "event-b", entity_family_hash: "family-b" },
        ],
      },
    });

    expect(
      await post(object, "/privacy-export", { identity: IDENTITY, eventIds: ["event-a"] }),
    ).toEqual({ records: [{ event_id: "event-a", entity_family_hash: "family-a" }] });
    expect(
      await post(object, "/privacy-delete", { identity: IDENTITY, eventIds: ["event-a"] }),
    ).toEqual({ deletedCount: 1 });

    const remaining = (await post(object, "/lookup", { identity: IDENTITY })) as {
      payload: { usage: unknown; exposureRows: unknown[] };
    };
    expect(remaining.payload).toEqual({
      usage: { idempotencyKey: "evaluation-1" },
      exposureRows: [{ event_id: "event-b", entity_family_hash: "family-b" }],
    });
    expect(
      await post(object, "/privacy-delete", { identity: IDENTITY, eventIds: ["event-a"] }),
    ).toEqual({ deletedCount: 0 });
  });

  it("purges the sealed usage and Exposure payload and makes retries non-delivering", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-28T00:00:00.000Z"));
    const object = new EvaluationCommitOutboxDurableObject(durableState());
    await post(object, "/commit", {
      identity: IDENTITY,
      payload: {
        usage: { appId: "app_1", flagKey: "checkout" },
        exposureRows: [{ event_id: "event-a", entity_family_hash: "family-a" }],
      },
    });

    await expect(post(object, "/privacy-delete-all", { identity: IDENTITY })).resolves.toEqual({
      proof: "evaluation-commit-outbox-purged-v1",
    });
    await expect(post(object, "/lookup", { identity: IDENTITY })).resolves.toMatchObject({
      delivered: true,
      payload: { usage: { privacyDeleted: true }, exposureRows: [] },
    });
    await expect(post(object, "/privacy-delete-all", { identity: IDENTITY })).resolves.toEqual({
      proof: "evaluation-commit-outbox-purged-v1",
    });
  });

  it("persists an App reset tombstone before a zero-Exposure commit can seal", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-28T00:00:00.000Z"));
    const object = new EvaluationCommitOutboxDurableObject(durableState());

    await post(object, "/privacy-delete-all", { identity: IDENTITY });
    const committed = await post(object, "/commit", {
      identity: IDENTITY,
      payload: { usage: { appId: "app_1", idempotencyKey: "late" }, exposureRows: [] },
    });

    expect(committed).toMatchObject({
      delivered: true,
      payload: { usage: { privacyDeleted: true }, exposureRows: [] },
    });
  });

  it("serializes an in-flight append before reset deletion can prove the outbox purged", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-28T00:00:00.000Z"));
    let releaseAppend!: () => void;
    let appendStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      appendStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    const object = new EvaluationCommitOutboxDurableObject(durableState(), {
      RAW_EVALUATIONS_QUEUE: {
        send: vi.fn(async () => {
          appendStarted();
          await released;
          return queueResult();
        }),
        sendBatch: vi.fn(),
        metrics: vi.fn(),
      },
      RAW_EVENTS_QUEUE: { send: vi.fn(), sendBatch: vi.fn(), metrics: vi.fn() },
      SPLITCH_PLATFORM_TARGET: "local",
    } as Env);
    await post(object, "/commit", {
      identity: IDENTITY,
      payload: {
        usage: {
          idempotencyKey: "evaluation-race",
          organizationId: "org_1",
          appId: "app_1",
          environmentId: "env_1",
          flagKey: "checkout",
          sdkRuntime: "javascript",
          evaluationCount: 1,
          isBatch: false,
          isCached: false,
          hasExposure: false,
          serverReceivedAt: "2026-08-28T00:00:00.000Z",
        },
        exposureRows: [],
      },
    });

    const delivery = post(object, "/deliver", { identity: IDENTITY });
    await started;
    let resetProved = false;
    const reset = post(object, "/privacy-delete-all", { identity: IDENTITY }).then((value) => {
      resetProved = true;
      return value;
    });
    await Promise.resolve();
    expect(resetProved).toBe(false);
    releaseAppend();
    await delivery;
    await expect(reset).resolves.toEqual({ proof: "evaluation-commit-outbox-purged-v1" });
    await expect(post(object, "/lookup", { identity: IDENTITY })).resolves.toMatchObject({
      delivered: true,
      payload: { usage: { privacyDeleted: true }, exposureRows: [] },
    });
  });
});

async function post(
  object: EvaluationCommitOutboxDurableObject,
  path: string,
  body: unknown,
): Promise<unknown> {
  const response = await object.fetch(
    new Request(`https://evaluation-commit-outbox.local${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  expect(response.status).toBe(200);
  return response.json();
}

function queueResult() {
  return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
}

function durableState(): DurableObjectState {
  const storage = new Map<string, unknown>();
  let section = Promise.resolve();
  return {
    blockConcurrencyWhile<T>(run: () => Promise<T>) {
      const result = section.then(run, run);
      section = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    storage: {
      async get<T>(key: string) {
        return storage.has(key) ? (structuredClone(storage.get(key)) as T) : undefined;
      },
      async put(key: string, value: unknown) {
        storage.set(key, structuredClone(value));
      },
      async delete(key: string | string[]) {
        if (Array.isArray(key)) {
          return key.reduce((count, item) => count + Number(storage.delete(item)), 0);
        }
        return storage.delete(key);
      },
      async setAlarm() {},
    },
  } as unknown as DurableObjectState;
}

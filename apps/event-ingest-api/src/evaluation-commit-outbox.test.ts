import { describe, expect, it, vi } from "vitest";
import { EvaluationCommitOutboxDurableObject } from "./evaluation-commit-outbox";
import type { Env } from "./types";

const IDENTITY = "a".repeat(64);

describe("Evaluation commit outbox privacy", () => {
  it("keeps a sealed commit unpublishable until inventory confirmation activates it", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-28T00:00:00.000Z"));
    const state = durableState();
    const send = vi.fn();
    const object = new EvaluationCommitOutboxDurableObject(state.ctx, {
      RAW_EVALUATIONS_QUEUE: { send },
      RAW_EVENTS_QUEUE: { sendBatch: vi.fn() },
      SPLITCH_PLATFORM_TARGET: "local",
    } as unknown as Env);

    const committed = await post(object, "/commit", {
      identity: IDENTITY,
      payload: { usage: { idempotencyKey: "evaluation-1" }, exposureRows: [] },
    });

    expect(committed).toMatchObject({ delivered: false, ready: false });
    expect(send).not.toHaveBeenCalled();
    expect(state.alarmTime()).toBeGreaterThan(Date.now());

    await object.alarm();
    expect(send).not.toHaveBeenCalled();
    await post(object, "/activate", { identity: IDENTITY });
    expect(state.alarmTime()).toBe(Date.now());
  });

  it("exports and redacts only the selected Entity exposure while retaining usage", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-28T00:00:00.000Z"));
    const object = new EvaluationCommitOutboxDurableObject(durableState().ctx);
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
    const object = new EvaluationCommitOutboxDurableObject(durableState().ctx);
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
    const object = new EvaluationCommitOutboxDurableObject(durableState().ctx);

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

  it("fails reset deletion loud while asynchronous Queue publication is unresolved", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-28T00:00:00.000Z"));
    let releaseAppend!: () => void;
    let appendStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      appendStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    const object = new EvaluationCommitOutboxDurableObject(durableState().ctx, {
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
    await post(object, "/activate", { identity: IDENTITY });

    const delivery = object.alarm();
    await started;
    const unresolved = await request(object, "/privacy-delete-all", { identity: IDENTITY });
    expect(unresolved.status).toBe(409);
    releaseAppend();
    await delivery;
    await expect(post(object, "/privacy-delete-all", { identity: IDENTITY })).resolves.toEqual({
      proof: "evaluation-commit-outbox-purged-v1",
    });
    await expect(post(object, "/lookup", { identity: IDENTITY })).resolves.toMatchObject({
      delivered: true,
      payload: { usage: { privacyDeleted: true }, exposureRows: [] },
    });
  });
});

describe("Evaluation commit outbox publication retry", () => {
  it("backs off repeated Queue publication failures", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const now = Date.parse("2026-08-28T00:00:00.000Z");
    vi.spyOn(Date, "now").mockReturnValue(now);
    const state = durableState();
    const send = vi.fn(async () => {
      throw new Error("queue unavailable");
    });
    const object = new EvaluationCommitOutboxDurableObject(state.ctx, {
      RAW_EVALUATIONS_QUEUE: { send },
      RAW_EVENTS_QUEUE: { sendBatch: vi.fn() },
      SPLITCH_PLATFORM_TARGET: "local",
    } as unknown as Env);
    await post(object, "/commit", {
      identity: IDENTITY,
      payload: { usage: { idempotencyKey: "evaluation-1" }, exposureRows: [] },
    });
    await post(object, "/activate", { identity: IDENTITY });

    await object.alarm();

    expect(state.stored()?.publicationAttempts).toBe(1);
    expect(state.alarmTime()).toBeGreaterThanOrEqual(now + 5_000);
    await object.alarm();
    expect(send).toHaveBeenCalledOnce();
    vi.spyOn(Date, "now").mockReturnValue(state.alarmTime() ?? now);
    await object.alarm();
    expect(state.stored()?.publicationAttempts).toBe(2);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("retains accepted usage past replay expiry until Queue publication succeeds", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const now = Date.parse("2026-08-28T00:00:00.000Z");
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const state = durableState();
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("queue unavailable"))
      .mockResolvedValue(queueResult());
    const object = new EvaluationCommitOutboxDurableObject(state.ctx, {
      RAW_EVALUATIONS_QUEUE: { send },
      RAW_EVENTS_QUEUE: { sendBatch: vi.fn() },
      SPLITCH_PLATFORM_TARGET: "local",
    } as unknown as Env);
    await post(object, "/commit", {
      identity: IDENTITY,
      payload: { usage: { idempotencyKey: "evaluation-1" }, exposureRows: [] },
    });
    await post(object, "/activate", { identity: IDENTITY });
    await object.alarm();

    clock.mockReturnValue(now + 24 * 60 * 60 * 1_000 + 1);
    await object.alarm();

    expect(send).toHaveBeenCalledTimes(2);
    expect(state.stored()).toBeUndefined();
  });
});

async function post(
  object: EvaluationCommitOutboxDurableObject,
  path: string,
  body: unknown,
): Promise<unknown> {
  const response = await request(object, path, body);
  expect(response.status).toBe(200);
  return response.json();
}

function request(
  object: EvaluationCommitOutboxDurableObject,
  path: string,
  body: unknown,
): Promise<Response> {
  return object.fetch(
    new Request(`https://evaluation-commit-outbox.local${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function queueResult() {
  return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
}

function durableState(): {
  ctx: DurableObjectState;
  alarmTime(): number | null;
  stored(): { publicationAttempts?: number } | undefined;
} {
  const storage = new Map<string, unknown>();
  let alarmTime: number | null = null;
  const ctx = {
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
      async setAlarm(time: number | Date) {
        alarmTime = typeof time === "number" ? time : time.getTime();
      },
    },
  } as unknown as DurableObjectState;
  return {
    ctx,
    alarmTime: () => alarmTime,
    stored: () =>
      storage.get("evaluation-commit-outbox") as { publicationAttempts?: number } | undefined,
  };
}

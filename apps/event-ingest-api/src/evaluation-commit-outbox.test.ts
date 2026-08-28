import { describe, expect, it, vi } from "vitest";
import { EvaluationCommitOutboxDurableObject } from "./evaluation-commit-outbox";

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

function durableState(): DurableObjectState {
  const storage = new Map<string, unknown>();
  return {
    storage: {
      async get<T>(key: string) {
        return storage.has(key) ? (structuredClone(storage.get(key)) as T) : undefined;
      },
      async put(key: string, value: unknown) {
        storage.set(key, structuredClone(value));
      },
      async delete(key: string) {
        return storage.delete(key);
      },
      async setAlarm() {},
    },
  } as unknown as DurableObjectState;
}

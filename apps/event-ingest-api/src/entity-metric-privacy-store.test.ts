import { describe, expect, it, vi } from "vitest";
import { EntityMetricPrivacyDurableObject } from "./entity-metric-privacy-store";
import type { Env } from "./types";

const ENTRY = {
  dedupKey: "sha256:event-1",
  fingerprint: "sha256:fingerprint-1",
  eventDefinitionId: "event_definition_checkout",
  eventDefinitionVersionId: "event_definition_checkout_v1",
  targetingKeyHash: "app-v1:aaaaaaaa",
  serverReceivedAt: "2026-08-07T00:00:00.000Z",
};
const EVALUATION_ENTRY = {
  commitIdentity: "a".repeat(64),
  eventId: "event-exposure-1",
  serverReceivedAt: ENTRY.serverReceivedAt,
};

describe("Entity Metric privacy Durable Object", () => {
  it("serializes suppression with registration and accepts only newly collected rows", async () => {
    const fixture = makeFixture();
    expect(await fixture.post("/register", ENTRY)).toEqual({ suppressed: false });

    expect(await fixture.post("/suppress", { deleteBeforeTs: "2026-08-07T00:00:01.000Z" })).toEqual(
      { proofs: ["metric-event-queue-suppression:2026-08-07T00:00:01.000Z"] },
    );
    expect(await fixture.post("/register", ENTRY)).toEqual({ suppressed: true });
    expect(await fixture.post("/register-evaluation", EVALUATION_ENTRY)).toEqual({
      suppressed: true,
    });
    expect(
      await fixture.post("/register", {
        ...ENTRY,
        dedupKey: "sha256:event-2",
        serverReceivedAt: "2026-08-07T00:00:02.000Z",
      }),
    ).toEqual({ suppressed: false });
  });

  it("exports pending outbox rows, redacts stale claims, and returns idempotent proofs", async () => {
    const fixture = makeFixture();
    await fixture.post("/register", ENTRY);
    await fixture.post("/register-evaluation", EVALUATION_ENTRY);

    const exported = await fixture.get("/export");
    const deleted = await fixture.post("/delete", {});
    const repeated = await fixture.post("/delete", {});

    expect(exported).toEqual({
      records: [
        { event_id: "event-1", targeting_key_hash: ENTRY.targetingKeyHash },
        { event_id: EVALUATION_ENTRY.eventId, source: "evaluation-commit" },
      ],
      proofs: ["metric-event-outbox-inventory:rows=1", "evaluation-commit-outbox-inventory:rows=1"],
    });
    expect(deleted).toEqual({
      proofs: [
        "metric-event-outbox-redaction:count=1",
        "evaluation-commit-outbox-redaction:count=1",
        "metric-event-queue:protected-by-durable-cutoff",
      ],
    });
    expect(repeated).toEqual({
      proofs: [
        "metric-event-outbox-redaction:count=0",
        "evaluation-commit-outbox-redaction:count=0",
        "metric-event-queue:protected-by-durable-cutoff",
      ],
    });
    expect(fixture.outboxFetch).toHaveBeenCalledWith(
      "https://metric-event-outbox.local/suppress",
      expect.objectContaining({ method: "POST" }),
    );
  });
});

function makeFixture() {
  const storage = new Map<string, unknown>();
  const outboxFetch = vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    if (path === "/export") {
      return Response.json({
        deleted: false,
        row: { event_id: "event-1", targeting_key_hash: ENTRY.targetingKeyHash },
      });
    }
    if (path === "/suppress") {
      return Response.json({ deleted: true, proof: "metric-event-outbox-redacted-v1" });
    }
    return new Response("not found", { status: 404 });
  });
  const ctx = {
    storage: {
      async get<T>(key: string) {
        return storage.has(key) ? (structuredClone(storage.get(key)) as T) : undefined;
      },
      async put(key: string, value: unknown) {
        storage.set(key, structuredClone(value));
      },
      async list<T>({ prefix }: { prefix: string }) {
        return new Map(
          [...storage.entries()]
            .filter(([key]) => key.startsWith(prefix))
            .map(([key, value]) => [key, structuredClone(value) as T]),
        );
      },
      async delete(keys: string | string[]) {
        if (Array.isArray(keys))
          return keys.reduce((count, key) => count + Number(storage.delete(key)), 0);
        return storage.delete(keys);
      },
    },
  } as unknown as DurableObjectState;
  const evaluationOutbox = {
    lookup: vi.fn(async () => null),
    commit: vi.fn(async () => {
      throw new Error("not used");
    }),
    acknowledge: vi.fn(async () => undefined),
    privacyExport: vi.fn(async () => [
      { event_id: EVALUATION_ENTRY.eventId, source: "evaluation-commit" },
    ]),
    privacyDelete: vi.fn(async () => 1),
  };
  const env = {
    METRIC_EVENT_OUTBOX: {
      idFromName: () => ({}) as DurableObjectId,
      get: () => ({ fetch: outboxFetch }),
    },
    EVALUATION_COMMIT_OUTBOX: evaluationOutbox,
  } as Env;
  const object = new EntityMetricPrivacyDurableObject(ctx, env);
  return {
    outboxFetch,
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
    async get(path: string) {
      const response = await object.fetch(new Request(`https://entity-privacy.local${path}`));
      expect(response.status).toBe(200);
      return response.json();
    },
  };
}

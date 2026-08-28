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

  it("serializes Entity inventory check-put against suppression", async () => {
    const fixture = makeFixture();
    const gate = fixture.pauseNextGet("privacy:suppression");
    const registration = fixture.post("/register", ENTRY);
    await gate.started;
    const suppression = fixture.post("/suppress", {
      deleteBeforeTs: "2026-08-07T00:00:01.000Z",
    });
    await Promise.resolve();
    gate.release();

    await expect(registration).resolves.toEqual({ suppressed: false });
    await expect(suppression).resolves.toEqual({
      proofs: ["metric-event-queue-suppression:2026-08-07T00:00:01.000Z"],
    });
    await expect(fixture.post("/register", ENTRY)).resolves.toEqual({ suppressed: true });
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

  it("keeps every Evaluation commit in the App reset inventory, including zero-Exposure commits", async () => {
    const fixture = makeFixture();
    const commitIdentity = "b".repeat(64);
    await fixture.post("/register-app-evaluation", {
      appId: "app_1",
      commitIdentity,
    });

    await expect(
      fixture.post("/reset-app", { appId: "app_1", resetId: "reset_1" }),
    ).resolves.toEqual({ proof: "event-delivery:entities=0;evaluation_commits=1" });
    expect(fixture.evaluationOutbox.privacyDeleteAll).toHaveBeenCalledWith(commitIdentity);
    await expect(fixture.post("/complete-reset", { resetId: "reset_1" })).resolves.toEqual({
      completed: true,
    });
    await expect(
      fixture.post("/register-app-evaluation", {
        appId: "app_1",
        commitIdentity: "e".repeat(64),
      }),
    ).resolves.toEqual({ suppressed: false });
    await expect(fixture.post("/complete-reset", { resetId: "reset_1" })).resolves.toEqual({
      completed: true,
    });
  });

  it("retains a failed Evaluation commit purge checkpoint across a Durable Object restart", async () => {
    const fixture = makeFixture();
    const commitIdentity = "c".repeat(64);
    await fixture.post("/register-app-evaluation", { appId: "app_1", commitIdentity });
    fixture.evaluationOutbox.privacyDeleteAll.mockRejectedValueOnce(
      new Error("forced purge failure"),
    );

    await expect(
      fixture.post("/reset-app", { appId: "app_1", resetId: "reset_2" }),
    ).rejects.toThrow("forced purge failure");
    fixture.restart();
    await expect(
      fixture.post("/reset-app", { appId: "app_1", resetId: "reset_2" }),
    ).resolves.toEqual({ proof: "event-delivery:entities=0;evaluation_commits=1" });
    expect(fixture.evaluationOutbox.privacyDeleteAll).toHaveBeenCalledTimes(2);
  });

  it("serializes App inventory check-put against reset suppression and purge", async () => {
    const fixture = makeFixture();
    const commitIdentity = "d".repeat(64);
    const gate = fixture.pauseNextGet("privacy:app-reset-suppression");
    const registration = fixture.post("/register-app-evaluation", {
      appId: "app_1",
      commitIdentity,
    });
    await gate.started;
    const reset = fixture.post("/reset-app", { appId: "app_1", resetId: "reset_race" });
    await Promise.resolve();
    expect(fixture.evaluationOutbox.privacyDeleteAll).not.toHaveBeenCalled();

    gate.release();
    await expect(registration).resolves.toEqual({ suppressed: false });
    await expect(reset).resolves.toEqual({
      proof: "event-delivery:entities=0;evaluation_commits=1",
    });
    expect(fixture.evaluationOutbox.privacyDeleteAll).toHaveBeenCalledWith(commitIdentity);
  });

  it("blocks standalone Evaluation usage delivery while App reset suppression is durable", async () => {
    const fixture = makeFixture();
    const append = vi.fn(async () => new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", append);
    const row = { app_id: "app_1", dedup_key: "sha256:usage" };

    await expect(fixture.post("/deliver-app-evaluation", { appId: "app_1", row })).resolves.toEqual(
      { suppressed: false },
    );
    await fixture.post("/reset-app", { appId: "app_1", resetId: "reset_usage" });
    await expect(fixture.post("/deliver-app-evaluation", { appId: "app_1", row })).resolves.toEqual(
      { suppressed: true },
    );
    expect(append).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});

function makeFixture() {
  const storage = new Map<string, unknown>();
  let blockedGet: { key: string; started: () => void; wait: Promise<void> } | undefined;
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
        if (blockedGet?.key === key) {
          const gate = blockedGet;
          blockedGet = undefined;
          gate.started();
          await gate.wait;
        }
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
    deliver: vi.fn(async () => {
      throw new Error("not used");
    }),
    acknowledge: vi.fn(async () => undefined),
    privacyExport: vi.fn(async () => [
      { event_id: EVALUATION_ENTRY.eventId, source: "evaluation-commit" },
    ]),
    privacyDelete: vi.fn(async () => 1),
    privacyDeleteAll: vi.fn(async () => "evaluation-commit-outbox-purged-v1" as const),
  };
  const env = {
    SPLITCH_PLATFORM_TARGET: "production",
    TINYBIRD_API_URL: "https://tinybird.test",
    TINYBIRD_INGEST_TOKEN: "test-token",
    METRIC_EVENT_OUTBOX: {
      idFromName: () => ({}) as DurableObjectId,
      get: () => ({ fetch: outboxFetch }),
    },
    EVALUATION_COMMIT_OUTBOX: evaluationOutbox,
  } as Env;
  let object = new EntityMetricPrivacyDurableObject(ctx, env);
  return {
    outboxFetch,
    evaluationOutbox,
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

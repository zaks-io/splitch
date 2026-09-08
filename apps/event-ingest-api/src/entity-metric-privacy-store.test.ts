import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ENTRY,
  EVALUATION_ENTRY,
  makeEntityMetricPrivacyStoreFixture,
} from "./entity-metric-privacy-store-test-fixture";

afterEach(() => vi.unstubAllGlobals());

describe("Entity Metric privacy Durable Object", () => {
  it("serializes suppression with registration and accepts only newly collected rows", async () => {
    const fixture = makeEntityMetricPrivacyStoreFixture();
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
    const fixture = makeEntityMetricPrivacyStoreFixture();
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

  it("does not expose the retired direct Tinybird delivery routes", async () => {
    const fixture = makeEntityMetricPrivacyStoreFixture();
    const responses = await Promise.all(
      ["/deliver-app-row", "/deliver-entity-row", "/deliver-row"].map((path) =>
        fixture.request(path, {}),
      ),
    );

    expect(responses.map((response) => response.status)).toEqual([404, 404, 404]);
  });

  it("keeps a durable queue delivery permit across restart until completion", async () => {
    const fixture = makeEntityMetricPrivacyStoreFixture();
    const row = {
      app_id: "app_1",
      id_type: "user",
      entity_family_hash: "app-v1:family",
      targeting_key_hash: "app-v1:entity",
      server_received_at: ENTRY.serverReceivedAt,
    };
    await expect(
      fixture.post("/admit-row", {
        datasource: "raw_events",
        deliveryId: "queue:raw_events:message-1",
        row,
      }),
    ).resolves.toEqual({ suppressed: false });
    fixture.restart();

    const blocked = await fixture.request("/suppress", {
      deleteBeforeTs: "2026-08-07T00:00:01.000Z",
    });
    expect(blocked.status).toBe(409);
    await expect(
      fixture.post("/complete-row", { deliveryId: "queue:raw_events:message-1" }),
    ).resolves.toEqual({ completed: true });
    await expect(
      fixture.post("/suppress", { deleteBeforeTs: "2026-08-07T00:00:01.000Z" }),
    ).resolves.toEqual({ proofs: ["metric-event-queue-suppression:2026-08-07T00:00:01.000Z"] });
  });

  it("exports pending outbox rows, redacts stale claims, and returns idempotent proofs", async () => {
    const fixture = makeEntityMetricPrivacyStoreFixture();
    await fixture.post("/register", ENTRY);
    await fixture.post("/register-evaluation", EVALUATION_ENTRY);

    const exported = await fixture.get("/export?limit=100");
    const deleted = await fixture.post("/delete", {});
    const repeated = await fixture.post("/delete", {});

    expect(exported).toEqual({
      records: [
        { event_id: "event-1", targeting_key_hash: ENTRY.targetingKeyHash },
        { event_id: EVALUATION_ENTRY.eventId, source: "evaluation-commit" },
      ],
      nextAfter: null,
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
      "sha256:event-1",
    );
  });
});

describe("Entity Metric privacy inventory pagination", () => {
  it("pages the two inventory prefixes in stable key order without duplicates or omissions", async () => {
    const fixture = makeEntityMetricPrivacyStoreFixture();
    for (const suffix of ["c", "a", "b"]) {
      await fixture.post("/register", {
        ...ENTRY,
        dedupKey: `sha256:event-${suffix}`,
      });
    }
    for (const eventId of ["event-exposure-2", "event-exposure-1"]) {
      await fixture.post("/register-evaluation", { ...EVALUATION_ENTRY, eventId });
    }

    const pages: Array<{ records: Array<{ event_id: string }>; nextAfter: string | null }> = [];
    let after: string | null = null;
    do {
      const query = new URLSearchParams({ limit: "2" });
      if (after !== null) query.set("after", after);
      const page = (await fixture.get(`/export?${query.toString()}`)) as (typeof pages)[number];
      pages.push(page);
      after = page.nextAfter;
    } while (after !== null);

    expect(pages).toHaveLength(3);
    expect(pages.map((page) => page.records.map((record) => record.event_id))).toEqual([
      ["event-a", "event-b"],
      ["event-c", "event-exposure-1"],
      ["event-exposure-2"],
    ]);
    const allIds = pages.flatMap((page) => page.records.map((record) => record.event_id));
    expect(new Set(allIds).size).toBe(allIds.length);
  });

  it("continues into Evaluation commits when Events exactly fill a page", async () => {
    const fixture = makeEntityMetricPrivacyStoreFixture();
    for (const suffix of ["a", "b"]) {
      await fixture.post("/register", {
        ...ENTRY,
        dedupKey: `sha256:event-${suffix}`,
      });
    }
    await fixture.post("/register-evaluation", EVALUATION_ENTRY);

    const first = (await fixture.get("/export?limit=2")) as {
      records: Array<{ event_id: string }>;
      nextAfter: string | null;
    };
    expect(first.records.map((record) => record.event_id)).toEqual(["event-a", "event-b"]);
    expect(first.nextAfter).toBe("event:sha256:event-b");
    if (first.nextAfter === null) throw new Error("expected a continuation key");

    const second = (await fixture.get(
      `/export?limit=2&after=${encodeURIComponent(first.nextAfter)}`,
    )) as typeof first;
    expect(second.records.map((record) => record.event_id)).toEqual(["event-exposure-1"]);
    expect(second.nextAfter).toBeNull();
  });

  it("rejects out-of-range page limits and never persists a raw Targeting Key", async () => {
    const fixture = makeEntityMetricPrivacyStoreFixture();
    const rawTargetingKey = "raw-targeting-key-must-not-persist";
    await fixture.post("/register", { ...ENTRY, targetingKey: rawTargetingKey });

    for (const limit of ["0", "101", "1.5"]) {
      await expect(fixture.get(`/export?limit=${limit}`)).rejects.toThrow(
        "page limit must be an integer in 1..100",
      );
    }
    expect(JSON.stringify(fixture.persistedState())).not.toContain(rawTargetingKey);
  });
});

describe("App identity delivery reset", () => {
  it("keeps every Evaluation commit in the App reset inventory, including zero-Exposure commits", async () => {
    const fixture = makeEntityMetricPrivacyStoreFixture();
    const commitIdentity = "b".repeat(64);
    await fixture.post("/register-app-evaluation", {
      appId: "app_1",
      commitIdentity,
      identityVersion: "app-v1",
    });

    await expect(
      fixture.post("/reset-app", {
        appId: "app_1",
        resetId: "reset_1",
        currentVersion: "app-v1",
      }),
    ).resolves.toEqual({ proof: "event-delivery:entities=0;evaluation_commits=1" });
    expect(fixture.evaluationOutbox.privacyDeleteAll).toHaveBeenCalledWith(commitIdentity);
    await expect(
      fixture.post("/complete-reset", { resetId: "reset_1", nextVersion: "app-v2" }),
    ).resolves.toEqual({
      completed: true,
    });
    await expect(
      fixture.post("/register-app-evaluation", {
        appId: "app_1",
        commitIdentity: "e".repeat(64),
        identityVersion: "app-v2",
      }),
    ).resolves.toEqual({ suppressed: false });
    await expect(
      fixture.post("/complete-reset", { resetId: "reset_1", nextVersion: "app-v2" }),
    ).resolves.toEqual({
      completed: true,
    });
  });

  it("retains a failed Evaluation commit purge checkpoint across a Durable Object restart", async () => {
    const fixture = makeEntityMetricPrivacyStoreFixture();
    const commitIdentity = "c".repeat(64);
    await fixture.post("/register-app-evaluation", {
      appId: "app_1",
      commitIdentity,
      identityVersion: "app-v1",
    });
    fixture.evaluationOutbox.privacyDeleteAll.mockRejectedValueOnce(
      new Error("forced purge failure"),
    );

    await expect(
      fixture.post("/reset-app", {
        appId: "app_1",
        resetId: "reset_2",
        currentVersion: "app-v1",
      }),
    ).rejects.toThrow("forced purge failure");
    fixture.restart();
    await expect(
      fixture.post("/reset-app", {
        appId: "app_1",
        resetId: "reset_2",
        currentVersion: "app-v1",
      }),
    ).resolves.toEqual({ proof: "event-delivery:entities=0;evaluation_commits=1" });
    expect(fixture.evaluationOutbox.privacyDeleteAll).toHaveBeenCalledTimes(2);
  });

  it("serializes App inventory check-put against reset suppression and purge", async () => {
    const fixture = makeEntityMetricPrivacyStoreFixture();
    const commitIdentity = "d".repeat(64);
    const gate = fixture.pauseNextGet("privacy:app-reset-suppression");
    const registration = fixture.post("/register-app-evaluation", {
      appId: "app_1",
      commitIdentity,
      identityVersion: "app-v1",
    });
    await gate.started;
    const reset = fixture.post("/reset-app", {
      appId: "app_1",
      resetId: "reset_race",
      currentVersion: "app-v1",
    });
    await Promise.resolve();
    expect(fixture.evaluationOutbox.privacyDeleteAll).not.toHaveBeenCalled();

    gate.release();
    await expect(registration).resolves.toEqual({ suppressed: false });
    await expect(reset).resolves.toEqual({
      proof: "event-delivery:entities=0;evaluation_commits=1",
    });
    expect(fixture.evaluationOutbox.privacyDeleteAll).toHaveBeenCalledWith(commitIdentity);
  });
});

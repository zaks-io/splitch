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

  it("does not let suppression and zero proof overtake an admitted Tinybird append", async () => {
    const fixture = makeEntityMetricPrivacyStoreFixture();
    let releaseAppend!: () => void;
    let markAppendStarted!: () => void;
    const appendStarted = new Promise<void>((resolve) => {
      markAppendStarted = resolve;
    });
    const appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    const append = vi.fn(async () => {
      markAppendStarted();
      await appendGate;
      return Response.json({ successful_rows: 1, quarantined_rows: 0 });
    });
    vi.stubGlobal("fetch", append);
    const row = {
      app_id: "app_1",
      id_type: "user",
      entity_family_hash: "app-v1:family",
      targeting_key_hash: "app-v1:entity",
      server_received_at: ENTRY.serverReceivedAt,
    };

    const delivery = fixture.post("/deliver-row", { datasource: "raw_events", row });
    await appendStarted;
    let deletionSettled = false;
    const deletion = fixture
      .post("/suppress", { deleteBeforeTs: "2026-08-07T00:00:01.000Z" })
      .then(() => fixture.post("/delete", {}))
      .finally(() => {
        deletionSettled = true;
      });
    await Promise.resolve();
    expect(deletionSettled).toBe(false);

    releaseAppend();
    await expect(delivery).resolves.toEqual({ suppressed: false });
    await expect(deletion).resolves.toMatchObject({ proofs: expect.any(Array) });
    await expect(fixture.post("/deliver-row", { datasource: "raw_events", row })).resolves.toEqual({
      suppressed: true,
    });
    expect(append).toHaveBeenCalledTimes(1);
  });

  it("exports pending outbox rows, redacts stale claims, and returns idempotent proofs", async () => {
    const fixture = makeEntityMetricPrivacyStoreFixture();
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

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRepository, envScope } from "../index";
import { claim, insertDelivery, insertInstallation, LATER, NOW } from "./delivery-claim-fixture";
import { createLocalD1, type LocalD1 } from "./test-d1-pool";
import { type SeededTenants, seedTwoTenants } from "./test-seed";

let local: LocalD1;
let seed: SeededTenants;
let repo: ReturnType<typeof createRepository>;
let deliveryId: string;

beforeEach(async () => {
  local = await createLocalD1();
  seed = await seedTwoTenants(local.d1);
  repo = createRepository(local.d1);
  await insertInstallation(local.d1, seed, "convex", "installation");
  deliveryId = (await insertDelivery(local.d1, seed, "convex", "installation")).deliveryId;
  await claim(repo, "convex", "owner");
});
afterEach(async () => local.dispose());

async function snapshot() {
  const installation = await local.d1
    .prepare("SELECT * FROM convex_installations WHERE installation_id = 'installation'")
    .first();
  const delivery = await local.d1
    .prepare("SELECT * FROM config_webhook_deliveries WHERE delivery_id = ?")
    .bind(deliveryId)
    .first();
  return JSON.stringify({ installation, delivery });
}

describe("Convex acknowledgment suppression", () => {
  it("claims the newest version and suppresses only older pending work after acknowledgment", async () => {
    await repo.convex.finishDelivery(deliveryId, "owner", { state: "pending", now: NOW });
    await insertDelivery(local.d1, seed, "convex", "installation", 0);
    const newest = await insertDelivery(local.d1, seed, "convex", "installation", 2);
    expect(await claim(repo, "convex", "newest-owner")).toEqual([
      expect.objectContaining({ deliveryId: newest.deliveryId, environmentVersion: 2 }),
    ]);
    const newer = await insertDelivery(local.d1, seed, "convex", "installation", 3);
    await insertInstallation(local.d1, seed, "convex", "sibling");
    const sibling = await insertDelivery(local.d1, seed, "convex", "sibling", 0);
    const started = Date.now();

    await repo.convex.finishDelivery(newest.deliveryId, "newest-owner", {
      state: "delivered",
      now: NOW,
    });

    const rows = await completionRows();
    const suppressed = rows.filter((row) => row.state === "suppressed");
    expect(suppressed.map((row) => row.delivery_id)).toEqual(["installation_0", deliveryId]);
    for (const row of suppressed) {
      expect(Date.parse(row.completed_at ?? "")).toBeGreaterThanOrEqual(started - 1_000);
    }
    expect(rows.find((row) => row.delivery_id === newest.deliveryId)).toMatchObject({
      state: "delivered",
      completed_at: NOW,
    });
    for (const id of [newer.deliveryId, sibling.deliveryId]) {
      expect(rows.find((row) => row.delivery_id === id)).toMatchObject({
        state: "pending",
        completed_at: null,
      });
    }
  });

  it.each(["stale", "revoked"] as const)(
    "cannot suppress older pending rows on a %s acknowledgment",
    async (condition) => {
      await insertDelivery(local.d1, seed, "convex", "installation", 0);
      if (condition === "revoked") {
        await local.d1
          .prepare(
            "UPDATE convex_installations SET status = 'revoked' WHERE installation_id = 'installation'",
          )
          .run();
      }
      const before = await completionRows();
      const health = await snapshot();
      await repo.convex.finishDelivery(
        deliveryId,
        condition === "stale" ? "stale-owner" : "owner",
        {
          state: "delivered",
          now: LATER,
        },
      );
      expect(await completionRows()).toEqual(before);
      expect(await snapshot()).toBe(health);
      expect(before.find((row) => row.delivery_id === "installation_0")).toMatchObject({
        state: "pending",
        completed_at: null,
      });
    },
  );
});

describe("Convex expired-lease supersession", () => {
  it("suppresses an abandoned older lease after a newer version succeeds", async () => {
    const newer = await insertDelivery(local.d1, seed, "convex", "installation", 2);
    const claimed = await claim(repo, "convex", "recovery", 25, LATER, "2026-08-25T00:06:00.000Z");
    expect(claimed.map((row) => row.deliveryId)).toEqual([newer.deliveryId]);
    await repo.convex.finishDelivery(newer.deliveryId, "recovery", {
      state: "delivered",
      now: LATER,
    });
    expect(
      await local.d1
        .prepare(
          "SELECT state, lease_owner, lease_expires_at, completed_at FROM config_webhook_deliveries WHERE delivery_id = ?",
        )
        .bind(deliveryId)
        .first(),
    ).toMatchObject({
      state: "suppressed",
      lease_owner: null,
      lease_expires_at: null,
      completed_at: expect.any(String),
    });
    expect(await claim(repo, "convex", "after", 25, LATER)).toEqual([]);
    const before = await snapshot();
    await repo.convex.finishDelivery(deliveryId, "owner", {
      state: "terminal",
      now: LATER,
      errorJson: '{"code":"STALE"}',
    });
    expect(await snapshot()).toBe(before);
  });

  it("preserves an older lease that is still in flight", async () => {
    const older = await insertDelivery(local.d1, seed, "convex", "installation", 0);
    await local.d1
      .prepare(
        "UPDATE config_webhook_deliveries SET state = 'leased', lease_owner = 'legacy', lease_expires_at = ? WHERE delivery_id = ?",
      )
      .bind(LATER, older.deliveryId)
      .run();
    await repo.convex.finishDelivery(deliveryId, "owner", { state: "delivered", now: NOW });
    expect(
      await local.d1
        .prepare(
          "SELECT state, lease_owner, completed_at FROM config_webhook_deliveries WHERE delivery_id = ?",
        )
        .bind(older.deliveryId)
        .first(),
    ).toEqual({ state: "leased", lease_owner: "legacy", completed_at: null });
  });
});

describe("Convex delivery completion", () => {
  it("records an owned acknowledgment before releasing its lease", async () => {
    await repo.convex.finishDelivery(deliveryId, "owner", { state: "delivered", now: NOW });
    const installation = await repo.convex.getInstallation(
      envScope(seed.a.appId, seed.a.environmentId),
      "installation",
    );
    expect(installation).toMatchObject({
      lastDeliveredVersion: 1,
      lastDeliveredAt: NOW,
      latestDeliveryErrorJson: null,
      updatedAt: NOW,
    });
    const row = await local.d1
      .prepare(
        "SELECT state, attempt_count, lease_owner, delivered_at FROM config_webhook_deliveries",
      )
      .first();
    expect(row).toEqual({
      state: "delivered",
      attempt_count: 1,
      lease_owner: null,
      delivered_at: NOW,
    });
  });

  it("records a retry and installation error while preserving delivery history", async () => {
    await repo.convex.finishDelivery(deliveryId, "owner", {
      state: "pending",
      now: NOW,
      nextAttemptAt: LATER,
      errorJson: '{"code":"CONNECT_TIMEOUT"}',
    });
    const installation = await repo.convex.getInstallation(
      envScope(seed.a.appId, seed.a.environmentId),
      "installation",
    );
    expect(installation).toMatchObject({
      lastDeliveredVersion: null,
      lastDeliveredAt: null,
      latestDeliveryErrorJson: '{"code":"CONNECT_TIMEOUT"}',
    });
    expect(await claim(repo, "convex", "early")).toEqual([]);
    expect(await claim(repo, "convex", "retry", 25, LATER)).toEqual([
      expect.objectContaining({ deliveryId, attemptCount: 1 }),
    ]);
  });

  it.each(["delivered", "pending", "terminal"] as const)(
    "leaves both rows byte-identical on a stale %s completion after reclamation",
    async (state) => {
      await claim(repo, "convex", "new-owner", 25, LATER, "2026-08-25T00:06:00.000Z");
      const before = await snapshot();
      await repo.convex.finishDelivery(deliveryId, "owner", {
        state,
        now: LATER,
        nextAttemptAt: LATER,
        errorJson: '{"code":"STALE"}',
      });
      expect(await snapshot()).toBe(before);
    },
  );

  it("ignores duplicate completion after the lease has already cleared", async () => {
    await repo.convex.finishDelivery(deliveryId, "owner", { state: "delivered", now: NOW });
    const before = await snapshot();
    await repo.convex.finishDelivery(deliveryId, "owner", {
      state: "terminal",
      now: LATER,
      errorJson: '{"code":"LATE"}',
    });
    expect(await snapshot()).toBe(before);
  });

  it.each(["delivered", "pending", "terminal"] as const)(
    "leaves both rows byte-identical on %s completion after revocation",
    async (state) => {
      await repo.convex.revokeInstallation(
        envScope(seed.a.appId, seed.a.environmentId),
        "installation",
        LATER,
      );
      const before = await snapshot();
      await repo.convex.finishDelivery(deliveryId, "owner", {
        state,
        now: LATER,
        nextAttemptAt: LATER,
        errorJson: '{"code":"REVOKED"}',
      });
      expect(await snapshot()).toBe(before);
    },
  );

  it("requires an active installation even when a revoked row still owns a lease", async () => {
    await local.d1
      .prepare(
        "UPDATE convex_installations SET status = 'revoked' WHERE installation_id = 'installation'",
      )
      .run();
    const before = await snapshot();
    await repo.convex.finishDelivery(deliveryId, "owner", { state: "delivered", now: LATER });
    expect(await snapshot()).toBe(before);
  });

  it("rolls back installation health when its independent outbox completion fails", async () => {
    const before = await snapshot();
    await local.d1
      .prepare(`CREATE TRIGGER reject_convex_completion BEFORE UPDATE ON config_webhook_deliveries
        WHEN NEW.state = 'delivered' BEGIN SELECT RAISE(ABORT, 'completion rejected'); END`)
      .run();
    try {
      await expect(
        repo.convex.finishDelivery(deliveryId, "owner", { state: "delivered", now: LATER }),
      ).rejects.toThrow("completion rejected");
      expect(await snapshot()).toBe(before);
    } finally {
      await local.d1.prepare("DROP TRIGGER reject_convex_completion").run();
    }
  });
});

async function completionRows() {
  const rows = await local.d1
    .prepare(`SELECT delivery_id, state, completed_at
    FROM config_webhook_deliveries ORDER BY delivery_id`)
    .all<{ delivery_id: string; state: string; completed_at: string | null }>();
  return rows.results;
}

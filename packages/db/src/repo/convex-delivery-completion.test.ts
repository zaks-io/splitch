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

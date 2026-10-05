import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRepository } from "../index";
import {
  insertDelivery,
  insertInstallation,
  LATER,
  NOW,
  observeD1,
} from "./delivery-claim-fixture";
import { envScope } from "./scope";
import { createLocalD1, type LocalD1 } from "./test-d1-pool";
import { type SeededTenants, seedTwoTenants } from "./test-seed";

let local: LocalD1;
let seed: SeededTenants;
const RETRY = "2026-08-25T00:30:00.000Z";
const failure = {
  secretCiphertext: "cipher_old",
  secretKeyVersion: "v1",
  now: NOW,
  retryAt: RETRY,
  errorJson: JSON.stringify({
    kind: "internal",
    code: "DELIVERY_PREPARATION_FAILED",
    occurredAt: NOW,
  }),
};
beforeEach(async () => {
  local = await createLocalD1();
  seed = await seedTwoTenants(local.d1);
});
afterEach(async () => local.dispose());

describe("Convex installation preparation backoff", () => {
  it("bounds a failed installation with 30 rows to one attempt and lets healthy work claim before the limit", async () => {
    await insertInstallation(local.d1, seed, "convex", "broken");
    for (let version = 1; version <= 30; version += 1)
      await insertDelivery(local.d1, seed, "convex", "broken", version);
    await insertInstallation(local.d1, seed, "convex", "healthy");
    await insertDelivery(local.d1, seed, "convex", "healthy");
    const observed = observeD1(local.d1);
    const repo = createRepository(observed.database);
    const claimed = await repo.convex.claimDueDeliveries(NOW, "failed", LATER, 25);
    expect(claimed.map((row) => row.environmentVersion)).toEqual([30, 1]);
    await repo.convex.finishDelivery("healthy_1", "failed", { state: "delivered", now: NOW });
    await repo.convex.deferPreparationFailure("broken", "failed", failure);
    expect(observed.batches).toEqual([2, 3, 2]);
    const healthy = await repo.convex.claimDueDeliveries(NOW, "healthy", LATER, 25);
    expect(healthy).toEqual([]);
    const rows = await local.d1
      .prepare(
        "SELECT state, count(*) AS count FROM config_webhook_deliveries WHERE installation_id = 'broken' GROUP BY state",
      )
      .all();
    expect(rows.results).toEqual([{ state: "pending", count: 30 }]);
    expect(
      await repo.convex.claimDueDeliveries("2026-08-25T00:29:59.000Z", "early", RETRY, 25),
    ).toEqual([]);
    expect(
      await repo.convex.claimDueDeliveries(RETRY, "retry", "2026-08-25T00:31:00.000Z", 25),
    ).toHaveLength(1);
  });

  it("serializes concurrent batches for one installation and recovers after lease expiry", async () => {
    await insertInstallation(local.d1, seed, "convex", "one");
    for (let version = 1; version <= 3; version += 1)
      await insertDelivery(local.d1, seed, "convex", "one", version);
    const repo = createRepository(local.d1);
    const [first, second] = await Promise.all([
      repo.convex.claimDueDeliveries(NOW, "a", LATER, 1),
      repo.convex.claimDueDeliveries(NOW, "b", LATER, 1),
    ]);
    expect(first.length + second.length).toBe(1);
    expect(await repo.convex.claimDueDeliveries(LATER, "recovery", RETRY, 3)).toHaveLength(1);
  });

  it("does not back off a rotated secret and allows immediate repair recovery", async () => {
    await insertInstallation(local.d1, seed, "convex", "repair");
    await insertDelivery(local.d1, seed, "convex", "repair");
    const repo = createRepository(local.d1);
    await repo.convex.claimDueDeliveries(NOW, "old", LATER, 25);
    await repo.convex.rotateSecret(envScope(seed.a.appId, seed.a.environmentId), "repair", {
      secretCiphertext: "repaired",
      secretKeyVersion: "v2",
      secretFingerprint: "new",
      rotationId: "rotation",
      now: NOW,
    });
    await repo.convex.deferPreparationFailure("repair", "old", failure);
    expect(
      await local.d1
        .prepare(
          "SELECT preparation_retry_at, latest_delivery_error_json FROM convex_installations WHERE installation_id = 'repair'",
        )
        .first(),
    ).toEqual({ preparation_retry_at: null, latest_delivery_error_json: null });
    const repaired = await repo.convex.claimDueDeliveries(NOW, "new", LATER, 25);
    expect(repaired[0]?.secretCiphertext).toBe("repaired");
    expect(repaired[0]?.attemptCount).toBe(0);
  });

  it("clears an existing cooldown on scoped rotation without changing another installation", async () => {
    await insertInstallation(local.d1, seed, "convex", "repair");
    await insertDelivery(local.d1, seed, "convex", "repair");
    const repo = createRepository(local.d1);
    await repo.convex.claimDueDeliveries(NOW, "old", LATER, 25);
    await repo.convex.deferPreparationFailure("repair", "old", failure);
    await repo.convex.rotateSecret(envScope(seed.b.appId, seed.b.environmentId), "repair", {
      secretCiphertext: "wrong",
      secretKeyVersion: "v1",
      secretFingerprint: "new",
      rotationId: "rotation",
      now: NOW,
    });
    expect(await repo.convex.claimDueDeliveries(NOW, "still-blocked", LATER, 25)).toEqual([]);
    await repo.convex.rotateSecret(envScope(seed.a.appId, seed.a.environmentId), "repair", {
      secretCiphertext: "repaired",
      secretKeyVersion: "v1",
      secretFingerprint: "new",
      rotationId: "rotation",
      now: NOW,
    });
    expect(await repo.convex.claimDueDeliveries(NOW, "new", LATER, 25)).toHaveLength(1);
  });

  it("ignores stale owners and revoked installations", async () => {
    await insertInstallation(local.d1, seed, "convex", "one");
    await insertDelivery(local.d1, seed, "convex", "one");
    const repo = createRepository(local.d1);
    await repo.convex.claimDueDeliveries(NOW, "live", LATER, 25);
    await repo.convex.deferPreparationFailure("one", "stale", failure);
    expect(
      await local.d1
        .prepare(
          "SELECT preparation_retry_at FROM convex_installations WHERE installation_id = 'one'",
        )
        .first(),
    ).toEqual({ preparation_retry_at: null });
    await repo.convex.revokeInstallation(envScope(seed.a.appId, seed.a.environmentId), "one", NOW);
    await repo.convex.deferPreparationFailure("one", "live", failure);
    expect(
      await local.d1.prepare("SELECT state, lease_owner FROM config_webhook_deliveries").first(),
    ).toEqual({ state: "suppressed", lease_owner: null });
  });
});

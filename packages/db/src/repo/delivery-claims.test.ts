import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appScope, createRepository } from "../index";
import {
  claim,
  DELIVERY_PROVIDERS,
  deliveryTable,
  insertDeliveries,
  insertDelivery,
  insertInstallation,
  installationTable,
  LATER,
  NOW,
  observeD1,
} from "./delivery-claim-fixture";
import { createLocalD1, type LocalD1 } from "./test-d1-pool";
import { type SeededTenants, seedTwoTenants } from "./test-seed";

let local: LocalD1;
let seed: SeededTenants;

beforeEach(async () => {
  local = await createLocalD1();
  seed = await seedTwoTenants(local.d1);
});
afterEach(async () => local.dispose());

describe.each(DELIVERY_PROVIDERS)("%s delivery claims", (provider) => {
  it("claims 25 deliveries in one D1 RPC with two SQL statements", async () => {
    await insertDeliveries(local.d1, seed, provider, 31);
    const observed = observeD1(local.d1);
    const rows = await claim(createRepository(observed.database), provider, "owner");
    expect(rows).toHaveLength(25);
    expect(observed.batches).toEqual([2]);
    expect(observed.directCalls()).toBe(0);
    expect(observed.queries).toHaveLength(2);
    expect(new Set(rows.map((row) => row.deliveryId)).size).toBe(25);
    const remaining = await claim(createRepository(local.d1), provider, "second");
    expect(remaining).toHaveLength(6);
  });

  it("enforces a smaller limit atomically", async () => {
    await insertDeliveries(local.d1, seed, provider, 8);
    const rows = await claim(createRepository(local.d1), provider, "owner", 3);
    expect(rows.map((row) => row.installationId)).toEqual([
      "installation_000",
      "installation_001",
      "installation_002",
    ]);
    const leased = await local.d1
      .prepare(`SELECT COUNT(*) AS count FROM ${deliveryTable(provider)} WHERE state = 'leased'`)
      .first<{ count: number }>();
    expect(leased?.count).toBe(3);
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects invalid limit %s before D1", async (limit) => {
    const observed = observeD1(local.d1);
    await expect(
      claim(createRepository(observed.database), provider, "owner", limit),
    ).rejects.toThrow("limit must be a positive integer");
    expect(observed.batches).toEqual([]);
    expect(observed.queries).toEqual([]);
  });

  it("returns only newly acquired deliveries when the same owner is reused", async () => {
    await insertDeliveries(local.d1, seed, provider, 3);
    const repo = createRepository(local.d1);
    const first = await claim(repo, provider, "same-owner", 2);
    const second = await claim(repo, provider, "same-owner", 1);
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(1);
    expect(new Set([...first, ...second].map((row) => row.deliveryId)).size).toBe(3);
    expect(await claim(repo, provider, "same-owner", 1)).toEqual([]);
  });

  it("rolls back its claim when the payload read fails", async () => {
    await insertDeliveries(local.d1, seed, provider, 1);
    const database = new Proxy(local.d1, {
      get(target, property, receiver) {
        if (property === "batch")
          return (statements: D1PreparedStatement[]) => {
            const first = statements[0];
            if (!first) throw new Error("Claim rollback fixture has no update statement");
            return target.batch([
              first,
              target.prepare("SELECT missing_payload_column FROM environments"),
            ]);
          };
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(claim(createRepository(database), provider, "failed")).rejects.toThrow(
      "missing_payload_column",
    );
    const row = await local.d1
      .prepare(`SELECT state, lease_owner, lease_expires_at FROM ${deliveryTable(provider)}`)
      .first();
    expect(row).toEqual({ state: "pending", lease_owner: null, lease_expires_at: null });
    expect(await claim(createRepository(local.d1), provider, "recovered")).toHaveLength(1);
  });

  it("gives concurrent claimers disjoint deliveries", async () => {
    await insertDeliveries(local.d1, seed, provider, 20);
    const repo = createRepository(local.d1);
    const [first, second] = await Promise.all([
      claim(repo, provider, "first", 7),
      claim(repo, provider, "second", 7),
    ]);
    expect(first).toHaveLength(7);
    expect(second).toHaveLength(7);
    expect(new Set([...first, ...second].map((row) => row.deliveryId)).size).toBe(14);
    expect(await claim(repo, provider, "third")).toHaveLength(6);
  });

  it("recovers only expired leases and preserves attempt counts", async () => {
    await insertDeliveries(local.d1, seed, provider, 1);
    const repo = createRepository(local.d1);
    const original = await claim(repo, provider, "first", 1);
    expect(await claim(repo, provider, "early", 1)).toEqual([]);
    const recovered = await claim(repo, provider, "recovery", 1, LATER, "2026-08-25T00:06:00.000Z");
    expect(recovered).toEqual(original);
    expect(recovered[0]?.attemptCount).toBe(0);
  });

  it("keeps future retries out of the claimed batch", async () => {
    await insertInstallation(local.d1, seed, provider, "retry");
    await insertDelivery(local.d1, seed, provider, "retry", 1, LATER);
    const repo = createRepository(local.d1);
    expect(await claim(repo, provider, "early")).toEqual([]);
    expect(await claim(repo, provider, "due", 25, LATER)).toHaveLength(1);
  });

  it("does not let revoked installations consume a limited slot", async () => {
    await insertDeliveries(local.d1, seed, provider, 2);
    await local.d1
      .prepare(`UPDATE ${installationTable(provider)} SET status = 'revoked'
        WHERE installation_id = 'installation_000'`)
      .run();
    const rows = await claim(createRepository(local.d1), provider, "owner", 1);
    expect(rows.map((row) => row.installationId)).toEqual(["installation_001"]);
    const revoked = await local.d1
      .prepare(`SELECT state, lease_owner FROM ${deliveryTable(provider)}
        WHERE installation_id = 'installation_000'`)
      .first();
    expect(revoked).toMatchObject({ state: "pending", lease_owner: null });
  });
});

describe("provider-specific delivery claim contracts", () => {
  it("scopes immediate Cloudflare work to one App, including expired leases", async () => {
    await insertInstallation(local.d1, seed, "cloudflare", "a");
    await insertDelivery(local.d1, seed, "cloudflare", "a");
    await insertInstallation(local.d1, seed, "cloudflare", "b", "b");
    await insertDelivery(local.d1, seed, "cloudflare", "b");
    await local.d1
      .prepare(
        "UPDATE cloudflare_config_deliveries SET app_id = ?, environment_id = ? WHERE installation_id = 'b'",
      )
      .bind(seed.b.appId, seed.b.environmentId)
      .run();
    const observed = observeD1(local.d1);
    const repo = createRepository(observed.database);
    const scoped = () =>
      repo.cloudflare.claimDueDeliveries(NOW, "scoped", LATER, 25, appScope(seed.a.appId));
    expect((await scoped()).map((row) => row.installationId)).toEqual(["a"]);
    expect(observed.batches).toEqual([2]);
    await local.d1
      .prepare(
        "UPDATE cloudflare_config_deliveries SET lease_expires_at = ? WHERE installation_id = 'a'",
      )
      .bind(NOW)
      .run();
    expect((await scoped()).map((row) => row.installationId)).toEqual(["a"]);
    expect((await claim(repo, "cloudflare", "cron")).map((row) => row.installationId)).toEqual([
      "b",
    ]);
  });

  it("claims the immutable Convex body with the installation's current secret", async () => {
    await insertInstallation(local.d1, seed, "convex", "convex");
    const inserted = await insertDelivery(local.d1, seed, "convex", "convex");
    await local.d1
      .prepare(`UPDATE convex_installations SET secret_ciphertext = 'cipher_current',
        secret_key_version = 'v2' WHERE installation_id = 'convex'`)
      .run();
    const rows = await createRepository(local.d1).convex.claimDueDeliveries(
      NOW,
      "owner",
      LATER,
      25,
    );
    expect(rows).toEqual([
      expect.objectContaining({
        deliveryId: inserted.deliveryId,
        bodyJson: inserted.bodyJson,
        secretCiphertext: "cipher_current",
        secretKeyVersion: "v2",
      }),
    ]);
  });

  it.each(DELIVERY_PROVIDERS)(
    "blocks an older %s delivery while a newer pending version is backed off",
    async (provider) => {
      await insertInstallation(local.d1, seed, provider, "backoff");
      await insertDelivery(local.d1, seed, provider, "backoff", 1);
      await insertDelivery(local.d1, seed, provider, "backoff", 2, LATER);
      const repo = createRepository(local.d1);
      expect(await claim(repo, provider, "early")).toEqual([]);
      const rows = await claim(repo, provider, "due", 25, LATER, "2026-08-25T00:06:00.000Z");
      expect(rows.map((row) => row.environmentVersion)).toEqual([2]);
      expect(await claim(repo, provider, "older", 25, LATER)).toEqual([]);
    },
  );

  it("ignores completed newer Cloudflare versions when choosing outstanding work", async () => {
    await insertInstallation(local.d1, seed, "cloudflare", "cloudflare");
    await insertDelivery(local.d1, seed, "cloudflare", "cloudflare", 1);
    const newer = await insertDelivery(local.d1, seed, "cloudflare", "cloudflare", 2);
    await local.d1
      .prepare("UPDATE cloudflare_config_deliveries SET state = 'terminal' WHERE delivery_id = ?")
      .bind(newer.deliveryId)
      .run();
    const rows = await claim(createRepository(local.d1), "cloudflare", "owner");
    expect(rows.map((row) => row.environmentVersion)).toEqual([1]);
  });
});

import { afterEach, beforeEach, expect, it } from "vitest";
import { createRepository } from "../index";
import {
  DELIVERY_PROVIDERS,
  type DeliveryProvider,
  deliveryTable,
  insertDelivery,
  insertInstallation,
  installationTable,
  NOW,
} from "./delivery-claim-fixture";
import { createLocalD1, type LocalD1 } from "./test-d1-pool";
import { type SeededTenants, seedTwoTenants } from "./test-seed";

let local: LocalD1;
let seed: SeededTenants;
const TICK = "2026-08-25T00:06:00.000Z";
const OLD = "2026-08-24T22:06:00.000Z";
const RECENT = "2026-08-25T00:05:00.000Z";
beforeEach(async () => {
  local = await createLocalD1();
  seed = await seedTwoTenants(local.d1);
});
afterEach(async () => local.dispose());

async function waiting(provider: DeliveryProvider, id: string, createdAt: string, version = 1) {
  if (version === 1) await insertInstallation(local.d1, seed, provider, id);
  await insertDelivery(local.d1, seed, provider, id, version);
  await local.d1
    .prepare(`UPDATE ${deliveryTable(provider)} SET created_at = ? WHERE delivery_id = ?`)
    .bind(createdAt, `${id}_${version}`)
    .run();
}

it.each(DELIVERY_PROVIDERS)(
  "%s groups only healthy active outstanding work by App and Environment",
  async (provider) => {
    await local.d1
      .prepare(
        "INSERT INTO environments (id, app_id, key, name, created_at, updated_at) VALUES ('env_recent', ?, 'recent', 'Recent', ?, ?)",
      )
      .bind(seed.a.appId, NOW, NOW)
      .run();
    await waiting(provider, "healthy", NOW);
    await waiting(provider, "healthy", RECENT, 2);
    await waiting(provider, "second", RECENT);
    await waiting(provider, "failing", OLD);
    await waiting(provider, "recent", RECENT);
    await waiting(provider, "revoked", OLD);
    await local.d1.batch([
      local.d1.prepare(
        `UPDATE ${installationTable(provider)} SET latest_delivery_error_json = '{}' WHERE installation_id = 'failing'`,
      ),
      local.d1.prepare(
        `UPDATE ${installationTable(provider)} SET status = 'revoked' WHERE installation_id = 'revoked'`,
      ),
      local.d1.prepare(
        `UPDATE ${installationTable(provider)} SET environment_id = 'env_recent' WHERE installation_id = 'recent'`,
      ),
      local.d1.prepare(
        `UPDATE ${deliveryTable(provider)} SET environment_id = 'env_recent' WHERE installation_id = 'recent'`,
      ),
      local.d1.prepare(
        `UPDATE ${deliveryTable(provider)} SET state = 'leased', lease_owner = 'other', lease_expires_at = '2026-08-25T00:07:00.000Z' WHERE delivery_id = 'healthy_1'`,
      ),
    ]);
    const rows = await createRepository(local.d1)[provider].deliveryLag(TICK);
    expect(rows).toHaveLength(2);
    expect(rows).toContainEqual({
      appId: seed.a.appId,
      environmentId: seed.a.environmentId,
      oldestOutstandingAt: NOW,
      healthyInstallationsWaiting: 2,
    });
    expect(rows).toContainEqual({
      appId: seed.a.appId,
      environmentId: "env_recent",
      oldestOutstandingAt: RECENT,
      healthyInstallationsWaiting: 1,
    });
    expect(
      rows.filter((row) => Date.parse(TICK) - Date.parse(row.oldestOutstandingAt) > 300_000),
    ).toEqual([expect.objectContaining({ environmentId: seed.a.environmentId })]);
  },
);

it.each(DELIVERY_PROVIDERS)(
  "%s excludes delivered, terminal, suppressed and failing-only Environments",
  async (provider) => {
    for (const state of ["delivered", "terminal", "suppressed"]) {
      await waiting(provider, state, OLD);
      await local.d1
        .prepare(`UPDATE ${deliveryTable(provider)} SET state = ? WHERE installation_id = ?`)
        .bind(state, state)
        .run();
    }
    await waiting(provider, "failing", OLD);
    await local.d1
      .prepare(
        `UPDATE ${installationTable(provider)} SET latest_delivery_error_json = '{}' WHERE installation_id = 'failing'`,
      )
      .run();
    expect(await createRepository(local.d1)[provider].deliveryLag(TICK)).toEqual([]);
  },
);

it("excludes future Convex preparation cooldowns and includes expired cooldowns", async () => {
  await waiting("convex", "cooldown", OLD);
  await local.d1
    .prepare("UPDATE convex_installations SET preparation_retry_at = '2026-08-25T00:07:00.000Z'")
    .run();
  const repo = createRepository(local.d1);
  expect(await repo.convex.deliveryLag(TICK)).toEqual([]);
  await local.d1
    .prepare("UPDATE convex_installations SET preparation_retry_at = ?")
    .bind(TICK)
    .run();
  expect(await repo.convex.deliveryLag(TICK)).toEqual([
    {
      appId: seed.a.appId,
      environmentId: seed.a.environmentId,
      oldestOutstandingAt: OLD,
      healthyInstallationsWaiting: 1,
    },
  ]);
});

it.each(DELIVERY_PROVIDERS)(
  "%s orders trigger and application timestamps chronologically",
  async (provider) => {
    await waiting(provider, "application", NOW);
    await waiting(provider, "trigger", "2026-08-25 00:05:00");
    const rows = await createRepository(local.d1)[provider].deliveryLag(TICK);
    expect(rows).toEqual([
      {
        appId: seed.a.appId,
        environmentId: seed.a.environmentId,
        oldestOutstandingAt: NOW,
        healthyInstallationsWaiting: 2,
      },
    ]);
  },
);

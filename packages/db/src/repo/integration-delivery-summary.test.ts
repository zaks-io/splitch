import { afterEach, beforeEach, expect, it } from "vitest";
import { createRepository, envScope } from "../index";
import {
  DELIVERY_PROVIDERS,
  deliveryTable,
  insertDelivery,
  insertInstallation,
} from "./delivery-claim-fixture";
import { createLocalD1, type LocalD1 } from "./test-d1-pool";
import { type SeededTenants, seedTwoTenants } from "./test-seed";

let local: LocalD1;
let seed: SeededTenants;
const NOW = Date.parse("2026-08-25T00:06:00Z");
beforeEach(async () => {
  local = await createLocalD1();
  seed = await seedTwoTenants(local.d1);
});
afterEach(async () => local.dispose());

it("counts outstanding work for both providers without completed history or other tenants", async () => {
  await seedDeliveries();
  const schedule = createRepository(local.d1).integrationDeliverySchedule;
  const summary = await schedule.outstandingSummary(
    envScope(seed.a.appId, seed.a.environmentId),
    NOW,
  );
  for (const provider of DELIVERY_PROVIDERS)
    expect(summary[provider]).toEqual({
      pendingCount: 1,
      leasedCount: 1,
      oldestOutstandingAgeMs: 360_000,
    });
  const other = await schedule.outstandingSummary(
    envScope(seed.b.appId, seed.b.environmentId),
    NOW,
  );
  for (const provider of DELIVERY_PROVIDERS)
    expect(other[provider]).toEqual({
      pendingCount: 0,
      leasedCount: 0,
      oldestOutstandingAgeMs: null,
    });
});

async function seedDeliveries() {
  for (const provider of DELIVERY_PROVIDERS) {
    for (const [version, state] of [
      "pending",
      "leased",
      "delivered",
      "terminal",
      "suppressed",
    ].entries()) {
      const id = `${provider}_${state}`;
      await insertInstallation(local.d1, seed, provider, id);
      await insertDelivery(local.d1, seed, provider, id, version);
      await local.d1
        .prepare(`UPDATE ${deliveryTable(provider)} SET state = ?,
        lease_owner = ?, lease_expires_at = ? WHERE installation_id = ?`)
        .bind(
          state,
          state === "leased" ? "worker" : null,
          state === "leased" ? "2026-08-25T00:07:00Z" : null,
          id,
        )
        .run();
    }
  }
}

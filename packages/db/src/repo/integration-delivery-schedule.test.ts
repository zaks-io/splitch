import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appScope, createRepository, envScope } from "../index";
import {
  DELIVERY_PROVIDERS,
  insertDelivery,
  insertInstallation,
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

describe("integration delivery schedule", () => {
  it.each(DELIVERY_PROVIDERS)(
    "isolates %s claims and deduplicates due Environments",
    async (provider) => {
      await insertInstallation(local.d1, seed, provider, "a");
      await insertDelivery(local.d1, seed, provider, "a");
      await insertInstallation(local.d1, seed, provider, "b", "b");
      await insertDelivery(local.d1, { ...seed, a: seed.b }, provider, "b");
      const repo = createRepository(local.d1);
      const scopes = [seed.a, seed.b].map(({ appId, environmentId }) => ({ appId, environmentId }));
      expect(
        await repo.integrationDeliverySchedule.environmentsWithDueDeliveries({ now: NOW }),
      ).toEqual(expect.arrayContaining(scopes));
      expect(
        await repo.integrationDeliverySchedule.environmentsWithDueDeliveries({
          now: NOW,
          scope: appScope(seed.a.appId),
        }),
      ).toEqual([scopes[0]]);
      const claimed = await repo[provider].claimDueDeliveries(
        NOW,
        "a",
        LATER,
        25,
        envScope(seed.a.appId, seed.a.environmentId),
      );
      expect(claimed.map((row) => row.installationId)).toEqual(["a"]);
      expect(
        await repo.integrationDeliverySchedule.environmentsWithDueDeliveries({
          now: NOW,
          scope: envScope(seed.a.appId, seed.b.environmentId),
        }),
      ).toEqual([]);
    },
  );

  it.each(DELIVERY_PROVIDERS)(
    "finds newest %s retries and leases without completed history",
    async (provider) => {
      await insertInstallation(local.d1, seed, provider, "a");
      await insertDelivery(local.d1, seed, provider, "a", 1);
      await insertDelivery(local.d1, seed, provider, "a", 2, LATER);
      const observed = observeD1(local.d1);
      const repo = createRepository(observed.database);
      const scope = envScope(seed.a.appId, seed.a.environmentId);
      expect(await repo.integrationDeliverySchedule.nextDeliveryWakeAt(scope, NOW)).toBe(LATER);
      const query = observed.queries[0];
      if (!query) throw new Error("Schedule did not prepare a read");
      const result = await local.d1
        .prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
        .bind(...query.values)
        .all<{ detail: string }>();
      const plan = result.results.map((row) => row.detail).join("\n");
      expect(plan).toContain(
        "convex_installations_scope_status_idx (app_id=? AND environment_id=? AND status=?)",
      );
      expect(plan).toContain("config_webhook_delivery_outstanding_idx (installation_id=?)");
      expect(plan).toMatch(
        /cloudflare_config_delivery_env_(due|expiry)_idx \(app_id=\? AND environment_id=\? AND state=\?\)/,
      );
      expect(plan).toContain(
        "cloudflare_config_delivery_outstanding_idx (installation_id=? AND environment_version>?)",
      );
      await repo[provider].claimDueDeliveries(
        LATER,
        "lease",
        "2026-08-25T00:06:00.000Z",
        25,
        scope,
      );
      expect(await repo.integrationDeliverySchedule.nextDeliveryWakeAt(scope, LATER)).toBe(
        "2026-08-25T00:06:00.000Z",
      );
    },
  );

  it("waits for both preparation and an older live Convex lease", async () => {
    await insertInstallation(local.d1, seed, "convex", "a");
    await insertDelivery(local.d1, seed, "convex", "a");
    const repo = createRepository(local.d1);
    const scope = envScope(seed.a.appId, seed.a.environmentId);
    await repo.convex.claimDueDeliveries(NOW, "lease", "2026-08-25T00:10:00.000Z", 25, scope);
    await insertDelivery(local.d1, seed, "convex", "a", 2);
    await local.d1
      .prepare("UPDATE convex_installations SET preparation_retry_at = ?")
      .bind(LATER)
      .run();
    expect(await repo.integrationDeliverySchedule.nextDeliveryWakeAt(scope, NOW)).toBe(
      "2026-08-25T00:10:00.000Z",
    );
    expect(
      await repo.integrationDeliverySchedule.environmentsWithDueDeliveries({ now: NOW }),
    ).toEqual([]);
    await local.d1.prepare("UPDATE config_webhook_deliveries SET state = 'delivered'").run();
    expect(await repo.integrationDeliverySchedule.nextDeliveryWakeAt(scope, NOW)).toBeNull();
  });
});

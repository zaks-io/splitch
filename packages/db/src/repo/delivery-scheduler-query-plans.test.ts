import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appScope, createRepository } from "../index";
import {
  claim,
  DELIVERY_PROVIDERS,
  insertDeliveries,
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

async function explain(query: { sql: string; values: unknown[] }) {
  const result = await local.d1
    .prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
    .bind(...query.values)
    .all<{ detail: string }>();
  return result.results.map((row) => row.detail).join("\n");
}

describe("delivery scheduler index plans", () => {
  it.each(DELIVERY_PROVIDERS)(
    "uses bounded indexed outstanding selection for %s",
    async (provider) => {
      await insertDeliveries(local.d1, seed, provider, 1);
      const observed = observeD1(local.d1);
      await claim(createRepository(observed.database), provider, "owner");
      const query = observed.queries[0];
      if (!query) throw new Error("Claim did not prepare an update");
      const plan = await explain(query);
      const prefix =
        provider === "convex" ? "config_webhook_delivery" : "cloudflare_config_delivery";
      if (provider === "convex") {
        expect(plan).toContain("convex_installations_preparation_due_idx (status=?)");
        expect(plan).toContain("config_webhook_delivery_outstanding_idx (installation_id=?)");
        expect(plan).toContain(
          "config_webhook_delivery_installation_version_unique (installation_id=? AND environment_version=?)",
        );
        expect(plan).toContain(
          "config_webhook_delivery_installation_lease_idx (installation_id=? AND state=? AND lease_expires_at>?)",
        );
        expect(plan).not.toContain(
          "config_webhook_delivery_lease_idx (state=? AND next_attempt_at<?)",
        );
      } else {
        expect(plan).toContain(`USING INDEX ${prefix}_lease_idx (state=? AND next_attempt_at<?)`);
        expect(plan).toContain(`USING INDEX ${prefix}_expiry_idx (state=? AND lease_expires_at<?)`);
        expect(plan).toContain(
          `USING INDEX ${prefix}_installation_version_unique (installation_id=? AND environment_version>?)`,
        );
      }
    },
  );

  it("does not read more delivery history as a blocked installation grows", async () => {
    await insertInstallation(local.d1, seed, "convex", "blocked");
    await insertDelivery(local.d1, seed, "convex", "blocked");
    await local.d1
      .prepare(
        "UPDATE convex_installations SET preparation_retry_at = ? WHERE installation_id = 'blocked'",
      )
      .bind(LATER)
      .run();
    await insertInstallation(local.d1, seed, "convex", "healthy");
    await insertDelivery(local.d1, seed, "convex", "healthy");
    const observed = observeD1(local.d1);
    const repo = createRepository(observed.database);
    expect((await claim(repo, "convex", "before")).map((row) => row.installationId)).toEqual([
      "healthy",
    ]);
    const before = observed.batchRowsRead[0];
    await repo.convex.finishDelivery("healthy_1", "before", {
      state: "pending",
      now: NOW,
      nextAttemptAt: NOW,
    });
    for (let version = 2; version <= 300; version++)
      await insertDelivery(local.d1, seed, "convex", "blocked", version);
    expect((await claim(repo, "convex", "after")).map((row) => row.installationId)).toEqual([
      "healthy",
    ]);
    expect(observed.batchRowsRead.at(-1)).toEqual(before);
  });

  it("uses the App index for scoped Cloudflare dispatch", async () => {
    await insertDeliveries(local.d1, seed, "cloudflare", 1);
    const observed = observeD1(local.d1);
    await createRepository(observed.database).cloudflare.claimDueDeliveries(
      NOW,
      "scoped",
      LATER,
      25,
      appScope(seed.a.appId),
    );
    const query = observed.queries[0];
    if (!query) throw new Error("Claim did not prepare an update");
    expect(await explain(query)).toContain("cloudflare_config_delivery_app_due_idx");
  });

  it("uses App and cursor ranges for Sentry due selection and pending event reads", async () => {
    const repo = createRepository(local.d1);
    await repo.sentry.createInstallation(seed.a.orgId, {
      installationId: "sentry",
      webhookUrl: "https://sentry.io/api/0/organizations/example/flags/hooks/provider/generic/",
      secretCiphertext: "cipher_synthetic",
      secretKeyVersion: "v1",
      secretFingerprint: "fingerprint",
      now: NOW,
    });
    const observed = observeD1(local.d1);
    const watching = createRepository(observed.database);
    await watching.sentry.dueInstallations(LATER, 25);
    await watching.flagChangeEvents.pendingForOrg(seed.a.orgId, 0, 100);
    expect(observed.queries).toHaveLength(2);
    for (const query of observed.queries) {
      const plan = await explain(query);
      expect(plan).toContain("flag_change_events_app_seq_idx (app_id=? AND seq>?)");
    }
  });
});

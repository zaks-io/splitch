import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appScope, createRepository, envScope } from "../index";
import {
  claim,
  DELIVERY_PROVIDERS,
  deliveryTable,
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

it.each(DELIVERY_PROVIDERS)(
  "bounds %s lag reads to outstanding state index ranges",
  async (provider) => {
    await insertDeliveries(local.d1, seed, provider, 1);
    const observed = observeD1(local.d1);
    await createRepository(observed.database)[provider].deliveryLag(NOW);
    expect(observed.queries).toHaveLength(1);
    const query = observed.queries[0];
    if (!query) throw new Error("Lag read did not prepare a query");
    const plan = await explain(query);
    const prefix = provider === "convex" ? "config_webhook_delivery" : "cloudflare_config_delivery";
    expect(plan).toContain(`SEARCH delivery USING INDEX ${prefix}_lease_idx (state=?)`);
    expect(plan).toContain(
      `SEARCH installation USING INDEX ${provider}_installations_scope_id_unique (app_id=? AND environment_id=? AND installation_id=?)`,
    );
    expect(plan).not.toMatch(/SCAN (delivery|installation)/);
    const statement = () =>
      local.d1
        .prepare(query.sql)
        .bind(...query.values)
        .all();
    await insertDelivery(local.d1, seed, provider, "installation_000", 2);
    const table =
      provider === "convex" ? "config_webhook_deliveries" : "cloudflare_config_deliveries";
    await local.d1
      .prepare(`UPDATE ${table} SET state = 'suppressed' WHERE environment_version = 2`)
      .run();
    const before = await statement();
    for (let version = 3; version <= 102; version++) {
      await insertDelivery(local.d1, seed, provider, "installation_000", version);
    }
    await local.d1
      .prepare(
        `UPDATE ${table} SET state = CASE environment_version % 3 WHEN 0 THEN 'delivered' WHEN 1 THEN 'terminal' ELSE 'suppressed' END WHERE environment_version > 1`,
      )
      .run();
    const after = await statement();
    expect(after.results).toEqual(before.results);
    expect(after.meta.rows_read).toBe(before.meta.rows_read);
  },
);

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
          `USING INDEX ${prefix}_outstanding_idx (installation_id=? AND environment_version>?)`,
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

  it.each(DELIVERY_PROVIDERS)("uses indexed Environment-scoped %s claims", async (provider) => {
    await insertDeliveries(local.d1, seed, provider, 1);
    const observed = observeD1(local.d1);
    await createRepository(observed.database)[provider].claimDueDeliveries(
      NOW,
      "scoped",
      LATER,
      25,
      envScope(seed.a.appId, seed.a.environmentId),
    );
    const query = observed.queries[0];
    if (!query) throw new Error("Claim did not prepare an update");
    const plan = await explain(query);
    expect(plan).toContain(
      provider === "convex"
        ? "convex_installations_scope_status_idx (app_id=? AND environment_id=? AND status=?)"
        : "cloudflare_config_delivery_env_due_idx (app_id=? AND environment_id=? AND state=? AND next_attempt_at<?)",
    );
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

it.each(DELIVERY_PROVIDERS)(
  "keeps scoped %s reads flat as another Environment grows",
  async (provider) => {
    const repo = createRepository(local.d1);
    const scope = envScope(seed.a.appId, seed.a.environmentId);
    await insertInstallation(local.d1, seed, provider, "target");
    await insertDelivery(local.d1, seed, provider, "target");
    const observed = observeD1(local.d1);
    const reading = createRepository(observed.database);
    async function measure(owner: string) {
      const rows = await reading[provider].claimDueDeliveries(NOW, owner, LATER, 6, scope);
      expect(rows.map((row) => row.installationId)).toEqual(["target"]);
      const claimReads = observed.batchRowsRead.at(-1);
      await repo[provider].finishDelivery("target_1", owner, {
        state: "pending",
        now: NOW,
        nextAttemptAt: LATER,
      });
      expect(await reading.integrationDeliverySchedule.nextDeliveryWakeAt(scope, NOW)).toBe(LATER);
      const wakeReads = observed.batchRowsRead.at(-1);
      await local.d1
        .prepare(
          `UPDATE ${deliveryTable(provider)} SET next_attempt_at = ? WHERE installation_id = 'target'`,
        )
        .bind(NOW)
        .run();
      return { claimReads, wakeReads };
    }
    await repo.identity.environments.insert(appScope(seed.a.appId), {
      id: "env_other",
      appId: seed.a.appId,
      key: "other",
      name: "Other",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const other = { ...seed, a: { ...seed.a, environmentId: "env_other" } };
    await insertInstallation(local.d1, other, provider, "other0");
    await insertDelivery(local.d1, other, provider, "other0");
    if (provider === "convex")
      await local.d1
        .prepare(
          "UPDATE config_webhook_deliveries SET state = 'leased', lease_owner = 'unrelated', lease_expires_at = ? WHERE environment_id = 'env_other'",
        )
        .bind(LATER)
        .run();
    const before = await measure("before");
    for (let i = 1; i < 1000; i++) {
      await insertInstallation(local.d1, other, provider, `other${i}`);
      await insertDelivery(local.d1, other, provider, `other${i}`);
    }
    if (provider === "convex") {
      await local.d1
        .prepare(
          "UPDATE config_webhook_deliveries SET state = 'leased', lease_owner = 'unrelated', lease_expires_at = ? WHERE environment_id = 'env_other'",
        )
        .bind(LATER)
        .run();
    }
    expect(await measure("after")).toEqual(before);
  },
);

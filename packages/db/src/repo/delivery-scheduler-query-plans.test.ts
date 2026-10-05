import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRepository } from "../index";
import {
  claim,
  DELIVERY_PROVIDERS,
  insertDeliveries,
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
    "uses separate pending and expired lease ranges for %s",
    async (provider) => {
      await insertDeliveries(local.d1, seed, provider, 1);
      const observed = observeD1(local.d1);
      await claim(createRepository(observed.database), provider, "owner");
      const query = observed.queries[0];
      if (!query) throw new Error("Claim did not prepare an update");
      const plan = await explain(query);
      const prefix =
        provider === "convex" ? "config_webhook_delivery" : "cloudflare_config_delivery";
      expect(plan).toContain(`USING INDEX ${prefix}_lease_idx (state=? AND next_attempt_at<?)`);
      expect(plan).toContain(`USING INDEX ${prefix}_expiry_idx (state=? AND lease_expires_at<?)`);
      if (provider === "cloudflare")
        expect(plan).toContain(
          "USING INDEX cloudflare_config_delivery_installation_version_unique (installation_id=? AND environment_version>?)",
        );
    },
  );

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

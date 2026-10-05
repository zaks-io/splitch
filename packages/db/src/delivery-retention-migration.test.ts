import { Miniflare } from "miniflare";
import { afterEach, expect, it } from "vitest";
import { applySchema, migrationFileStatements, migrationStatementsThrough } from "./repo/test-d1";

let mf: Miniflare | undefined;
afterEach(async () => {
  await mf?.dispose();
  mf = undefined;
});

it("additively retains legacy finished rows for 30 days from migration unless acknowledgement is known", async () => {
  mf = new Miniflare({
    modules: true,
    script: "export default {};",
    d1Databases: { DB: ":memory:" },
  });
  const d1 = (await mf.getD1Database("DB")) as unknown as D1Database;
  await applySchema(d1, migrationStatementsThrough("0039_delivery_scheduler_indexes.sql"));
  const old = "2020-01-01T00:00:00.000Z";
  const acknowledged = "2026-09-01T00:00:00.000Z";
  await d1.batch([
    d1
      .prepare(`INSERT INTO organizations (id, name, slug, plan, created_at, updated_at)
      VALUES ('org', 'Org', 'org', 'free', ?, ?)`)
      .bind(old, old),
    d1
      .prepare(`INSERT INTO apps (id, organization_id, name, key, created_at, updated_at)
      VALUES ('app', 'org', 'App', 'app', ?, ?)`)
      .bind(old, old),
    d1
      .prepare(`INSERT INTO environments (id, app_id, name, key, created_at, updated_at)
      VALUES ('env', 'app', 'Environment', 'env', ?, ?)`)
      .bind(old, old),
    d1
      .prepare(`INSERT INTO convex_installations (installation_id, app_id, environment_id,
      callback_url, secret_ciphertext, secret_key_version, secret_fingerprint, status, created_at, updated_at)
      VALUES ('installation', 'app', 'env', 'https://example.convex.site', 'ciphertext', 'v1', 'fingerprint', 'active', ?, ?)`)
      .bind(old, old),
    d1
      .prepare(`INSERT INTO cloudflare_installations (installation_id, app_id, environment_id,
      endpoint, secret_ciphertext, secret_key_version, secret_fingerprint, status, created_at, updated_at)
      VALUES ('installation', 'app', 'env', 'https://example.workers.dev', 'ciphertext', 'v1', 'fingerprint', 'active', ?, ?)`)
      .bind(old, old),
  ]);
  await seedLegacyDeliveries(d1, "config_webhook_deliveries", old, acknowledged);
  await seedLegacyDeliveries(d1, "cloudflare_config_deliveries", old, acknowledged);

  const started = Date.now();
  await applySchema(d1, migrationFileStatements("0041_delivery_retention.sql"));

  for (const table of ["config_webhook_deliveries", "cloudflare_config_deliveries"]) {
    const rows = await d1
      .prepare(`SELECT state, completed_at, created_at FROM ${table} ORDER BY environment_version`)
      .all<{ state: string; completed_at: string | null; created_at: string }>();
    expect(rows.results).toHaveLength(6);
    expect(rows.results.every((row) => row.created_at === old)).toBe(true);
    expect(rows.results[0]?.completed_at).toBeNull();
    expect(rows.results[1]?.completed_at).toBeNull();
    expect(rows.results[2]?.completed_at).toBe(acknowledged);
    for (const row of rows.results.slice(3)) {
      expect(Date.parse(row.completed_at ?? "")).toBeGreaterThanOrEqual(started - 1_000);
      expect(Date.parse(row.completed_at ?? "")).toBeLessThanOrEqual(Date.now() + 1_000);
    }
  }
});

async function seedLegacyDeliveries(
  d1: D1Database,
  table: string,
  old: string,
  acknowledged: string,
) {
  const convex = table === "config_webhook_deliveries";
  for (const [version, state] of [
    "pending",
    "leased",
    "delivered",
    "terminal",
    "suppressed",
    "delivered",
  ].entries()) {
    const deliveredAt = state === "delivered" && version === 2 ? acknowledged : null;
    await d1
      .prepare(`INSERT INTO ${table} (delivery_id, installation_id, app_id, environment_id,
        environment_version, state, next_attempt_at, created_at, delivered_at${convex ? ", body_json" : ""})
        VALUES (?, 'installation', 'app', 'env', ?, ?, ?, ?, ?${convex ? ", '{}'" : ""})`)
      .bind(`row-${version}`, version, state, old, old, deliveredAt)
      .run();
  }
}

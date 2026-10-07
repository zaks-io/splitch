import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRepository, envScope } from "../index";
import { pruneCloudflareDeliveries, pruneConvexDeliveries } from "./delivery-retention";
import { createLocalD1, type LocalD1 } from "./test-d1-pool";
import { type SeededTenants, seedTwoTenants } from "./test-seed";

const CREATED = "2020-01-01T00:00:00.000Z";
const CUTOFF = "2026-08-01T00:00:00.000Z";
const BEFORE = "2026-07-31T23:59:59.999Z";
const AFTER = "2026-08-01T00:00:00.001Z";
const INSTALLATION = "00000000-0000-4000-8000-000000000081";
const ADAPTERS = [
  { kind: "convex", table: "config_webhook_deliveries", prune: pruneConvexDeliveries },
  { kind: "cloudflare", table: "cloudflare_config_deliveries", prune: pruneCloudflareDeliveries },
] as const;

let local: LocalD1;
let tenants: SeededTenants;
let repo: ReturnType<typeof createRepository>;
let version: number;

beforeEach(async () => {
  local = await createLocalD1();
  tenants = await seedTwoTenants(local.d1);
  repo = createRepository(local.d1);
  version = 100;
  const scope = envScope(tenants.a.appId, tenants.a.environmentId);
  const common = {
    installationId: INSTALLATION,
    secretCiphertext: "ciphertext",
    secretKeyVersion: "v1",
    secretFingerprint: "fingerprint",
    now: CREATED,
  };
  await repo.convex.createInstallation(scope, {
    ...common,
    callbackUrl: "https://example.convex.site/config",
  });
  await repo.cloudflare.createInstallation(scope, {
    ...common,
    endpoint: "https://example.workers.dev/config",
  });
  await local.d1.batch(ADAPTERS.map(({ table }) => local.d1.prepare(`DELETE FROM ${table}`)));
});

afterEach(async () => local.dispose());

for (const { kind, table, prune } of ADAPTERS) {
  describe(`${kind} delivery retention`, () => {
    it("prunes only finished rows strictly before the cutoff in bounded batches", async () => {
      for (const state of ["delivered", "terminal", "suppressed"]) {
        await seed(table, state, state);
        await setCompleted(table, state, BEFORE);
      }
      await seed(table, "boundary", "terminal");
      await setCompleted(table, "boundary", CUTOFF);
      await seed(table, "recent", "suppressed");
      await setCompleted(table, "recent", AFTER);
      await seed(table, "pending", "pending");
      await seed(table, "leased", "leased");
      // Even an inconsistent legacy timestamp must never expire outstanding work.
      await setCompleted(table, "pending", BEFORE);
      await setCompleted(table, "leased", BEFORE);

      expect(await prune(local.d1, { completedBefore: CUTOFF, limit: 2 })).toBe(2);
      expect(await prune(local.d1, { completedBefore: CUTOFF, limit: 2 })).toBe(1);
      expect(await ids(table)).toEqual(["boundary", "leased", "pending", "recent"]);
    });

    it("stamps actual state transitions, clears rearmed work, and preserves diagnostic updates", async () => {
      await seed(table, "retry", "pending");
      await expect(completed(table, "retry")).resolves.toBeNull();
      const started = Date.now();
      await local.d1
        .prepare(`UPDATE ${table} SET state = 'terminal' WHERE delivery_id = 'retry'`)
        .run();
      const first = await completed(table, "retry");
      expect(Date.parse(first ?? "")).toBeGreaterThanOrEqual(started - 1_000);
      await local.d1
        .prepare(`UPDATE ${table} SET last_error_json = '{}' WHERE delivery_id = 'retry'`)
        .run();
      expect(await completed(table, "retry")).toBe(first);
      await local.d1
        .prepare(`UPDATE ${table} SET state = 'pending' WHERE delivery_id = 'retry'`)
        .run();
      expect(await completed(table, "retry")).toBeNull();
      await local.d1
        .prepare(`UPDATE ${table} SET state = 'leased' WHERE delivery_id = 'retry'`)
        .run();
      expect(await completed(table, "retry")).toBeNull();
      await local.d1
        .prepare(
          `UPDATE ${table} SET state = 'delivered', delivered_at = ? WHERE delivery_id = 'retry'`,
        )
        .bind(AFTER)
        .run();
      expect(await completed(table, "retry")).toBe(AFTER);
    });

    it("records revocation suppression without using old creation or delivery timestamps", async () => {
      await seed(table, "suppressed", "leased");
      await local.d1
        .prepare(`UPDATE ${table} SET delivered_at = ? WHERE delivery_id = 'suppressed'`)
        .bind(CREATED)
        .run();
      const started = Date.now();
      await repo[kind].revokeInstallation(
        envScope(tenants.a.appId, tenants.a.environmentId),
        INSTALLATION,
        AFTER,
      );
      const timestamp = await completed(table, "suppressed");
      expect(Date.parse(timestamp ?? "")).toBeGreaterThanOrEqual(started - 1_000);
      expect(await prune(local.d1, { completedBefore: CUTOFF, limit: 100 })).toBe(0);
    });

    it("preserves completion concurrent with pruning after a long retry history", async () => {
      await seed(table, "in-flight", "leased");
      await local.d1
        .prepare(`UPDATE ${table} SET lease_owner = 'owner' WHERE delivery_id = 'in-flight'`)
        .run();
      const now = new Date().toISOString();
      await Promise.all([
        repo[kind].finishDelivery("in-flight", "owner", { state: "delivered", now }),
        prune(local.d1, { completedBefore: CUTOFF, limit: 100 }),
      ]);
      expect(await ids(table)).toEqual(["in-flight"]);
      expect(await completed(table, "in-flight")).toBe(now);
    });

    it("uses the retention index and rejects invalid batch limits", async () => {
      const index =
        kind === "convex"
          ? "config_webhook_delivery_completed_idx"
          : "cloudflare_config_delivery_completed_idx";
      const plan = await local.d1
        .prepare(`EXPLAIN QUERY PLAN SELECT delivery_id FROM ${table} INDEXED BY ${index}
        WHERE state IN ('delivered', 'terminal', 'suppressed') AND completed_at < ?
        ORDER BY completed_at LIMIT ?`)
        .bind(CUTOFF, 100)
        .all<{ detail: string }>();
      expect(plan.results.map((row) => row.detail).join(" ")).toContain("completed_idx");
      for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        await expect(prune(local.d1, { completedBefore: CUTOFF, limit })).rejects.toThrow(
          "positive integer",
        );
      }
    });

    it("caps an oversized prune request at 1,000 rows", async () => {
      const bodyColumn = kind === "convex" ? ", body_json" : "";
      const bodyValue = kind === "convex" ? ", '{}'" : "";
      await local.d1
        .prepare(`WITH RECURSIVE batch(n) AS (
        SELECT 1 UNION ALL SELECT n + 1 FROM batch WHERE n < 1001
      ) INSERT INTO ${table} (delivery_id, installation_id, app_id, environment_id,
        environment_version, state, next_attempt_at, created_at, delivered_at${bodyColumn})
      SELECT 'batch-' || n, ?, ?, ?, n, 'delivered', ?, ?, ?${bodyValue} FROM batch`)
        .bind(INSTALLATION, tenants.a.appId, tenants.a.environmentId, CREATED, CREATED, BEFORE)
        .run();
      expect(await prune(local.d1, { completedBefore: CUTOFF, limit: 10_000 })).toBe(1_000);
      expect(await ids(table)).toHaveLength(1);
    });
  });
}

it("records Cloudflare suppression from the existing config-commit trigger", async () => {
  await seed("cloudflare_config_deliveries", "older", "pending");
  await local.d1
    .prepare("UPDATE environments SET config_version = config_version + 1 WHERE id = ?")
    .bind(tenants.a.environmentId)
    .run();
  expect(await completed("cloudflare_config_deliveries", "older")).toMatch(/^\d{4}-\d{2}-\d{2}T/);
});

async function seed(table: string, id: string, state: string) {
  const bodyColumn = table === "config_webhook_deliveries" ? ", body_json" : "";
  const bodyValue = table === "config_webhook_deliveries" ? ", '{}'" : "";
  await local.d1
    .prepare(`INSERT INTO ${table}
    (delivery_id, installation_id, app_id, environment_id, environment_version,
     state, next_attempt_at, created_at${bodyColumn}) VALUES (?, ?, ?, ?, ?, ?, ?, ?${bodyValue})`)
    .bind(
      id,
      INSTALLATION,
      tenants.a.appId,
      tenants.a.environmentId,
      version++,
      state,
      CREATED,
      CREATED,
    )
    .run();
}

async function setCompleted(table: string, id: string, value: string) {
  await local.d1
    .prepare(`UPDATE ${table} SET completed_at = ? WHERE delivery_id = ?`)
    .bind(value, id)
    .run();
}

async function completed(table: string, id: string) {
  const row = await local.d1
    .prepare(`SELECT completed_at FROM ${table} WHERE delivery_id = ?`)
    .bind(id)
    .first<{ completed_at: string | null }>();
  if (!row) throw new Error(`Missing delivery ${id}`);
  return row.completed_at;
}

async function ids(table: string) {
  const rows = await local.d1
    .prepare(`SELECT delivery_id FROM ${table} ORDER BY delivery_id`)
    .all<{ delivery_id: string }>();
  return rows.results.map((row) => row.delivery_id);
}

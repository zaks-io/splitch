import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import { appScope, createRepository } from "./index";
import { applySchema, migrationFileStatements, migrationStatementsThrough } from "./repo/test-d1";

let mf: Miniflare | undefined;

afterEach(async () => {
  await mf?.dispose();
  mf = undefined;
});

const NOW = "2026-01-01T00:00:00.000Z";
const LIFECYCLE_MIGRATION = "0036_flag_lifecycle.sql";

async function d1Through(lastMigration: string): Promise<D1Database> {
  mf = new Miniflare({
    modules: true,
    script: "export default {};",
    d1Databases: { DB: ":memory:" },
  });
  const d1 = (await mf.getD1Database("DB")) as unknown as D1Database;
  await applySchema(d1, migrationStatementsThrough(lastMigration));
  await d1.batch([
    d1
      .prepare(
        "INSERT INTO organizations (id, name, slug, plan, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind("org_lifecycle", "Lifecycle", "lifecycle", "free", NOW, NOW),
    d1
      .prepare(
        "INSERT INTO apps (id, organization_id, name, key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind("app_lifecycle", "org_lifecycle", "Lifecycle", "lifecycle", NOW, NOW),
  ]);
  return d1;
}

describe("Flag lifecycle migration (D9)", () => {
  it("lands every pre-existing Flag in a readable unclassified state", async () => {
    const d1 = await d1Through("0034_metric_direction.sql");
    await d1
      .prepare(
        "INSERT INTO flags (id, app_id, key, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind("flag_legacy", "app_lifecycle", "legacy-flag", "Legacy Flag", NOW, NOW)
      .run();

    await applySchema(d1, migrationFileStatements(LIFECYCLE_MIGRATION));

    const repo = createRepository(d1);
    await expect(
      repo.flags.getFlag(appScope("app_lifecycle"), "flag_legacy"),
    ).resolves.toMatchObject({ lifecycleClass: "unclassified", owner: null, expiresAt: null });
    // No expiry means no removal plan, so a legacy Flag is never reported as expired.
    await expect(
      repo.flags.listExpiredFlagPage(appScope("app_lifecycle"), "2999-01-01T00:00:00.000Z", 10),
    ).resolves.toEqual([]);
  });

  it("refuses a class outside the vocabulary at the database", async () => {
    const d1 = await d1Through(LIFECYCLE_MIGRATION);
    await expect(
      d1
        .prepare(
          "INSERT INTO flags (id, app_id, key, name, lifecycle_class, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind("flag_bad", "app_lifecycle", "bad", "Bad", "temporary", NOW, NOW)
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/);
  });
});

describe("listExpiredFlagPage", () => {
  it("returns expired Flags most overdue first and leaves unexpired ones out", async () => {
    const d1 = await d1Through(LIFECYCLE_MIGRATION);
    const repo = createRepository(d1);
    const scope = appScope("app_lifecycle");
    const flag = (id: string, expiresAt: string | null) => ({
      id,
      appId: "app_lifecycle",
      key: id.replaceAll("_", "-"),
      name: id,
      lifecycleClass: "release" as const,
      owner: "checkout-team",
      expiresAt,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await repo.flags.flags.insert(scope, flag("flag_recent", "2026-03-01T00:00:00.000Z"));
    await repo.flags.flags.insert(scope, flag("flag_overdue", "2026-02-01T00:00:00.000Z"));
    await repo.flags.flags.insert(scope, flag("flag_future", "2026-09-01T00:00:00.000Z"));
    await repo.flags.flags.insert(scope, { ...flag("flag_ops", null), lifecycleClass: "ops" });

    const expired = await repo.flags.listExpiredFlagPage(scope, "2026-06-01T00:00:00.000Z", 10);

    expect(expired.map((row) => row.id)).toEqual(["flag_overdue", "flag_recent"]);
    await expect(
      repo.flags.listExpiredFlagPage(appScope("app_other"), "2026-06-01T00:00:00.000Z", 10),
    ).resolves.toEqual([]);
  });
});

describe("updateFlag lifecycle compare-and-set", () => {
  it("refuses a lifecycle write whose expected lifecycle no longer holds", async () => {
    const d1 = await d1Through(LIFECYCLE_MIGRATION);
    const repo = createRepository(d1);
    const scope = appScope("app_lifecycle");
    await repo.flags.flags.insert(scope, {
      id: "flag_cas",
      appId: "app_lifecycle",
      key: "flag-cas",
      name: "CAS",
      lifecycleClass: "ops",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const stale = { lifecycleClass: "ops" as const, owner: null, expiresAt: null };
    await repo.flags.updateFlag(scope, "flag_cas", {
      lifecycleClass: "release",
      owner: "checkout-team",
      expiresAt: "2026-09-01T00:00:00.000Z",
    });

    const lost = await repo.flags.updateFlag(scope, "flag_cas", { expiresAt: null }, stale);

    expect(lost).toBeNull();
    await expect(repo.flags.getFlag(scope, "flag_cas")).resolves.toMatchObject({
      lifecycleClass: "release",
      expiresAt: "2026-09-01T00:00:00.000Z",
    });
  });
});

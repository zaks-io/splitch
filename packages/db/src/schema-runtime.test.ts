import { describe, expect, it } from "vitest";
import { createLocalD1, RESET_TABLES } from "./repo/test-d1-pool";

describe("applied D1 schema", () => {
  it("retains a nullable same-App Segment foreign key with restrictive delete", async () => {
    const local = await createLocalD1();
    try {
      const columns = await local.d1
        .prepare("PRAGMA table_info('targeting_rules')")
        .all<{ name: string; notnull: number }>();
      expect(columns.results.find((column) => column.name === "segment_id")).toMatchObject({
        notnull: 0,
      });
      const foreignKeys = await local.d1
        .prepare("PRAGMA foreign_key_list('targeting_rules')")
        .all<{ table: string; from: string; to: string; on_delete: string }>();
      expect(foreignKeys.results).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            table: "segments",
            from: "app_id",
            to: "app_id",
            on_delete: "RESTRICT",
          }),
          expect.objectContaining({
            table: "segments",
            from: "segment_id",
            to: "id",
            on_delete: "RESTRICT",
          }),
        ]),
      );
    } finally {
      await local.dispose();
    }
  });

  it("enforces same-App Segment ownership and restrictive deletion at write time", async () => {
    const local = await createLocalD1();
    try {
      const now = "2026-08-07T00:00:00.000Z";
      await local.d1.batch([
        local.d1
          .prepare(
            "INSERT INTO organizations (id, name, slug, plan, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .bind("org_segment_fk", "Segment FK", "segment-fk", "free", now, now),
        local.d1
          .prepare(
            "INSERT INTO apps (id, organization_id, name, key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .bind("app_one", "org_segment_fk", "App One", "app-one", now, now),
        local.d1
          .prepare(
            "INSERT INTO apps (id, organization_id, name, key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .bind("app_two", "org_segment_fk", "App Two", "app-two", now, now),
        local.d1
          .prepare(
            "INSERT INTO environments (id, app_id, key, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .bind("env_one", "app_one", "dev", "Development", now, now),
        local.d1
          .prepare(
            "INSERT INTO flags (id, app_id, key, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .bind("flag_one", "app_one", "checkout", "Checkout", now, now),
        local.d1
          .prepare(
            "INSERT INTO segments (id, app_id, name, conditions, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .bind("segment_shared_id", "app_two", "Other App", "[]", now, now),
      ]);

      await expect(
        local.d1
          .prepare(
            "INSERT INTO targeting_rules (id, app_id, environment_id, flag_id, priority, conditions, segment_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .bind(
            "rule_cross_app",
            "app_one",
            "env_one",
            "flag_one",
            0,
            "[]",
            "segment_shared_id",
            now,
            now,
          )
          .run(),
      ).rejects.toThrow(/FOREIGN KEY constraint failed/u);

      await local.d1
        .prepare(
          "INSERT INTO segments (id, app_id, name, conditions, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind("segment_live", "app_one", "Live", "[]", now, now)
        .run();
      await local.d1
        .prepare(
          "INSERT INTO targeting_rules (id, app_id, environment_id, flag_id, priority, conditions, segment_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind("rule_live", "app_one", "env_one", "flag_one", 0, "[]", "segment_live", now, now)
        .run();

      await expect(
        local.d1.prepare("DELETE FROM segments WHERE id = ?").bind("segment_live").run(),
      ).rejects.toThrow(/FOREIGN KEY constraint failed/u);
    } finally {
      await local.dispose();
    }
  });
});

describe("remaining applied D1 schema", () => {
  it("makes the frozen control_variant_id NOT NULL", async () => {
    const local = await createLocalD1();
    try {
      const columns = await local.d1
        .prepare("PRAGMA table_info('runs')")
        .all<{ name: string; notnull: number }>();
      expect(columns.results.find((column) => column.name === "control_variant_id")).toMatchObject({
        notnull: 1,
      });
    } finally {
      await local.dispose();
    }
  });

  it("contains the 31 named live D1 tables", async () => {
    const local = await createLocalD1();
    try {
      const tables = await local.d1
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('_cf_METADATA', 'd1_migrations')",
        )
        .all<{ name: string }>();
      expect(tables.results.map((table) => table.name).sort()).toEqual([...RESET_TABLES].sort());
      expect(tables.results.map((table) => table.name).sort()).toEqual([
        "api_keys",
        "app_deletion_sagas",
        "app_memberships",
        "approval_requests",
        "approval_reviews",
        "apps",
        "claim_consent_attempts",
        "claim_idempotency",
        "claim_verifications",
        "client_keys",
        "cloudflare_config_deliveries",
        "cloudflare_installations",
        "config_webhook_deliveries",
        "convex_installations",
        "device_refresh_sessions",
        "entity_deletions",
        "environments",
        "event_definition_versions",
        "event_definitions",
        "experiments",
        "flag_configs",
        "flags",
        "metrics",
        "org_memberships",
        "organizations",
        "privacy_requests",
        "runs",
        "segments",
        "targeting_rules",
        "trusted_idps",
        "variants",
      ]);
    } finally {
      await local.dispose();
    }
  });
});

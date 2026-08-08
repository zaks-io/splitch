import { describe, expect, it } from "vitest";
import { createLocalD1, RESET_TABLES } from "./repo/test-d1-pool";

describe("applied D1 schema", () => {
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

  it("contains the 24 named live D1 tables", async () => {
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
        "app_memberships",
        "approval_requests",
        "approval_reviews",
        "apps",
        "claim_consent_attempts",
        "claim_idempotency",
        "claim_verifications",
        "client_keys",
        "device_refresh_sessions",
        "entity_deletions",
        "environments",
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

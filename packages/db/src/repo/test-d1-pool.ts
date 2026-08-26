import { env } from "cloudflare:workers";

export const RESET_TABLES = [
  "cloudflare_config_deliveries",
  "cloudflare_installations",
  "config_webhook_deliveries",
  "convex_installations",
  "sentry_installations",
  "event_definition_versions",
  "event_definitions",
  "approval_reviews",
  "approval_requests",
  "claim_idempotency",
  "claim_consent_attempts",
  "runs",
  "privacy_requests",
  "entity_deletions",
  "api_keys",
  "client_keys",
  "targeting_rules",
  "flag_configs",
  "experiments",
  "metrics",
  "segments",
  "variants",
  "flags",
  "device_refresh_sessions",
  "trusted_idps",
  "app_memberships",
  "environments",
  "app_deletion_sagas",
  "apps",
  "org_memberships",
  "claim_verifications",
  "organizations",
  // LAST on purpose: deleting flags/variants/targeting_rules/flag_configs above
  // fires the audit triggers, which insert fresh rows into this table. Purging
  // it earlier would leave the reset incomplete and leak one test's history into
  // the next.
  "flag_change_events",
] as const;

export type LocalD1 = {
  d1: D1Database;
  dispose: () => Promise<void>;
};

let leased = false;

export async function resetD1Database(d1: D1Database): Promise<void> {
  await d1.batch(RESET_TABLES.map((table) => d1.prepare(`DELETE FROM ${table}`)));
}

/** Lease the file's in-process D1 binding with a clean database. */
export async function createLocalD1(): Promise<LocalD1> {
  if (leased) throw new Error("test-d1-pool: D1 is already leased in this test file");
  leased = true;

  const d1 = (env as typeof env & { DB: D1Database }).DB;
  try {
    await resetD1Database(d1);
  } catch (error) {
    leased = false;
    throw error;
  }

  let disposed = false;
  return {
    d1,
    dispose: async () => {
      if (disposed) throw new Error("test-d1-pool: D1 lease was already disposed");
      disposed = true;
      leased = false;
    },
  };
}

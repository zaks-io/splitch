import { Miniflare } from "miniflare";

/**
 * Local fixture substrate for the control-plane auth-middleware tests.
 *
 * A Miniflare local D1 carries only the roots the mounted handlers read/write
 * (organizations, org_memberships, apps, environments, credentials); the full
 * migration set is gated by @splitch/db's own suite, so this test stays
 * self-contained. Miniflare local KV backs session-validation and credential
 * cache reads. No real WorkOS, no network.
 */

const SCHEMA = [
  `CREATE TABLE organizations (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, plan TEXT DEFAULT 'free' NOT NULL, stripe_customer_id TEXT, stripe_subscription_id TEXT, sso_enabled INTEGER DEFAULT 0 NOT NULL, is_provisional INTEGER DEFAULT 0 NOT NULL, demo_expires_at TEXT, claim_acquired_at TEXT, claim_acquisition_token TEXT, claim_acquisition_key_hash TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE org_memberships (org_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (org_id, user_id))`,
  `CREATE TABLE apps (id TEXT PRIMARY KEY NOT NULL, organization_id TEXT NOT NULL, name TEXT NOT NULL, key TEXT NOT NULL, description TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by TEXT)`,
  `CREATE UNIQUE INDEX apps_org_key_unique ON apps (organization_id, key)`,
  `CREATE TABLE app_memberships (app_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (app_id, user_id))`,
  `CREATE TABLE environments (id TEXT PRIMARY KEY NOT NULL, app_id TEXT NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL, policy TEXT DEFAULT '{"variantAvailability":"allow","targetingRolloutValue":"allow","enabledState":"allow","startExperimentRun":"allow"}' NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by TEXT)`,
  `CREATE UNIQUE INDEX environments_app_key_unique ON environments (app_id, key)`,
  `CREATE TABLE client_keys (key_id TEXT PRIMARY KEY NOT NULL, app_id TEXT NOT NULL, environment_id TEXT NOT NULL, key_material TEXT NOT NULL, origin_allowlist TEXT, rate_limit_rps INTEGER, revoked_at TEXT, created_at TEXT NOT NULL, created_by TEXT)`,
  `CREATE UNIQUE INDEX client_keys_active_env_unique ON client_keys (app_id, environment_id) WHERE revoked_at IS NULL`,
  `CREATE TABLE api_keys (key_id TEXT PRIMARY KEY NOT NULL, app_id TEXT NOT NULL, environment_id TEXT NOT NULL, key_hash TEXT NOT NULL, scopes TEXT NOT NULL, revoked_at TEXT, last_rotated_at TEXT, created_at TEXT NOT NULL, created_by TEXT)`,
  `CREATE INDEX api_keys_key_hash_idx ON api_keys (key_hash)`,
  `CREATE TABLE flags (id TEXT PRIMARY KEY NOT NULL, app_id TEXT NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL, description TEXT, schema TEXT, default_variant_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by TEXT, updated_by TEXT, version INTEGER DEFAULT 1 NOT NULL)`,
  `CREATE UNIQUE INDEX flags_app_key_unique ON flags (app_id, key)`,
  `CREATE TABLE variants (id TEXT PRIMARY KEY NOT NULL, flag_id TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL, description TEXT, created_at TEXT NOT NULL)`,
  `CREATE TABLE flag_configs (id TEXT PRIMARY KEY NOT NULL, app_id TEXT NOT NULL, environment_id TEXT NOT NULL, flag_id TEXT NOT NULL, enabled INTEGER DEFAULT 0 NOT NULL, available_variant_names TEXT NOT NULL, default_variant_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER DEFAULT 1 NOT NULL)`,
  `CREATE UNIQUE INDEX flag_configs_flag_env_unique ON flag_configs (flag_id, environment_id)`,
  `CREATE TABLE targeting_rules (id TEXT PRIMARY KEY NOT NULL, app_id TEXT NOT NULL, environment_id TEXT NOT NULL, flag_id TEXT NOT NULL, priority INTEGER NOT NULL, conditions TEXT NOT NULL, variant_id TEXT, percentage_rollout TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE segments (id TEXT PRIMARY KEY NOT NULL, app_id TEXT NOT NULL, name TEXT NOT NULL, conditions TEXT NOT NULL, description TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE experiments (id TEXT PRIMARY KEY NOT NULL, app_id TEXT NOT NULL, environment_id TEXT NOT NULL, key TEXT NOT NULL, flag_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT, hypothesis TEXT, status TEXT DEFAULT 'draft' NOT NULL, targeting_key_field TEXT NOT NULL, targeting_key_type TEXT NOT NULL, confidence_level REAL DEFAULT 0.95 NOT NULL, default_variant_id TEXT, metrics TEXT NOT NULL, guardrail_metrics TEXT NOT NULL, activation_metric_id TEXT, conversion_window_ms INTEGER DEFAULT 0 NOT NULL, dimensions TEXT NOT NULL, draft_allocation TEXT, draft_salt TEXT, draft_targeting_rules TEXT, draft_segment_ids TEXT, live_run_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by TEXT, updated_by TEXT)`,
  `CREATE UNIQUE INDEX experiments_app_env_key_unique ON experiments (app_id, environment_id, key)`,
  `CREATE TABLE runs (id TEXT PRIMARY KEY NOT NULL, app_id TEXT NOT NULL, environment_id TEXT NOT NULL, experiment_id TEXT NOT NULL, run_number INTEGER NOT NULL, status TEXT DEFAULT 'running' NOT NULL, targeting_key_field TEXT NOT NULL, targeting_key_type TEXT NOT NULL, salt TEXT NOT NULL, allocation TEXT NOT NULL, variant_set TEXT NOT NULL, targeting_rules TEXT NOT NULL, confidence_level REAL NOT NULL, horizon TEXT DEFAULT 'sequential' NOT NULL, target_n INTEGER, sample_size_locked INTEGER, decision_family TEXT NOT NULL, guardrail_decisions TEXT NOT NULL, config_hash TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, start_reason TEXT, end_reason TEXT, created_at TEXT NOT NULL, created_by TEXT)`,
  `CREATE UNIQUE INDEX runs_experiment_salt_unique ON runs (experiment_id, salt)`,
  `CREATE UNIQUE INDEX runs_experiment_run_number_unique ON runs (experiment_id, run_number)`,
  `CREATE TABLE metrics (id TEXT PRIMARY KEY NOT NULL, app_id TEXT NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL, description TEXT, kind TEXT NOT NULL, event_name TEXT NOT NULL, event_value_field TEXT, denominator_metric_id TEXT, created_at TEXT NOT NULL, created_by TEXT)`,
  `CREATE UNIQUE INDEX metrics_app_key_unique ON metrics (app_id, key)`,
  `CREATE TABLE privacy_requests (request_id TEXT PRIMARY KEY NOT NULL, org_id TEXT NOT NULL, app_id TEXT, request_type TEXT NOT NULL, subject_type TEXT NOT NULL, subject_ref TEXT NOT NULL, requested_by TEXT NOT NULL, status TEXT NOT NULL, received_at TEXT NOT NULL, ack_due_at TEXT NOT NULL, response_due_at TEXT NOT NULL, completed_at TEXT, denial_reason TEXT)`,
  `CREATE TABLE entity_deletions (app_id TEXT NOT NULL, id_type TEXT NOT NULL, targeting_key_hash TEXT NOT NULL, delete_before_ts TEXT NOT NULL, requested_at TEXT NOT NULL, completed_at TEXT, PRIMARY KEY (app_id, id_type, targeting_key_hash, delete_before_ts))`,
  `CREATE TABLE claim_verifications (id TEXT PRIMARY KEY NOT NULL, provisional_user_hash TEXT NOT NULL, email_hash TEXT NOT NULL, expires_at TEXT NOT NULL, attempts INTEGER DEFAULT 0 NOT NULL, verified_at TEXT, consumed_at TEXT, created_at TEXT NOT NULL)`,
  `CREATE TABLE claim_consent_attempts (id TEXT PRIMARY KEY NOT NULL, verification_id TEXT NOT NULL, existing_user_hash TEXT NOT NULL, expires_at TEXT NOT NULL, approved_at TEXT, consumed_at TEXT, created_at TEXT NOT NULL)`,
  `CREATE TABLE claim_idempotency (key_hash TEXT NOT NULL, verification_id TEXT NOT NULL, provisional_user_hash TEXT NOT NULL, email_hash TEXT NOT NULL, organization_hash TEXT NOT NULL, app_hash TEXT NOT NULL, verified_user_hash TEXT NOT NULL, completed_at TEXT, expires_at TEXT NOT NULL, PRIMARY KEY (key_hash, provisional_user_hash, email_hash, organization_hash, app_hash, verified_user_hash))`,
];

export interface LocalBindings {
  d1: D1Database;
  kv: KVNamespace;
  credentialKv: KVNamespace;
  dispose: () => Promise<void>;
}

export async function makeLocalBindings(): Promise<LocalBindings> {
  const mf = new Miniflare({
    modules: true,
    script: "export default {};",
    d1Databases: { DB: ":memory:" },
    kvNamespaces: { SESSION_STORE: "sessions", CREDENTIAL_STORE: "credentials" },
  });
  const d1 = (await mf.getD1Database("DB")) as unknown as D1Database;
  const kv = (await mf.getKVNamespace("SESSION_STORE")) as unknown as KVNamespace;
  const credentialKv = (await mf.getKVNamespace("CREDENTIAL_STORE")) as unknown as KVNamespace;
  for (const statement of SCHEMA) {
    await d1.exec(statement);
  }
  return { d1, kv, credentialKv, dispose: () => mf.dispose() };
}

export interface SeedRow {
  orgId: string;
  orgName: string;
  appId: string;
  appName: string;
  appKey: string;
}

const NOW = "2026-06-29T00:00:00.000Z";

/** Insert one Org + its App (the roots are above the App tenant boundary). */
export async function seedOrgApp(d1: D1Database, row: SeedRow): Promise<void> {
  await d1
    .prepare(
      "INSERT INTO organizations (id, name, plan, created_at, updated_at) VALUES (?,?,?,?,?)",
    )
    .bind(row.orgId, row.orgName, "free", NOW, NOW)
    .run();
  await d1
    .prepare(
      "INSERT INTO apps (id, organization_id, name, key, created_at, updated_at) VALUES (?,?,?,?,?,?)",
    )
    .bind(row.appId, row.orgId, row.appName, row.appKey, NOW, NOW)
    .run();
}

export interface SeedOrgMember {
  orgId: string;
  userId: string;
  role: "owner" | "admin" | "member";
  createdAt?: string;
}

export async function seedOrgMember(d1: D1Database, row: SeedOrgMember): Promise<void> {
  await d1
    .prepare("INSERT INTO org_memberships (org_id, user_id, role, created_at) VALUES (?,?,?,?)")
    .bind(row.orgId, row.userId, row.role, row.createdAt ?? NOW)
    .run();
}

export interface SeedAppMember {
  appId: string;
  userId: string;
  role: "owner" | "admin" | "member";
  createdAt?: string;
}

export async function seedAppMember(d1: D1Database, row: SeedAppMember): Promise<void> {
  await d1
    .prepare("INSERT INTO app_memberships (app_id, user_id, role, created_at) VALUES (?,?,?,?)")
    .bind(row.appId, row.userId, row.role, row.createdAt ?? NOW)
    .run();
}

export interface SeedEnvironment {
  appId: string;
  environmentId: string;
  key: string;
  name?: string;
  policy?: string;
}

export async function seedEnvironment(d1: D1Database, row: SeedEnvironment): Promise<void> {
  await d1
    .prepare(
      "INSERT INTO environments (id, app_id, key, name, policy, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
    )
    .bind(
      row.environmentId,
      row.appId,
      row.key,
      row.name ?? row.key,
      row.policy ??
        '{"variantAvailability":"allow","targetingRolloutValue":"allow","enabledState":"allow","startExperimentRun":"allow"}',
      NOW,
      NOW,
    )
    .run();
}

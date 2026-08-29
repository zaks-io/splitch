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
  `CREATE TABLE organizations (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, slug TEXT NOT NULL, plan TEXT DEFAULT 'free' NOT NULL, stripe_customer_id TEXT, stripe_subscription_id TEXT, sso_enabled INTEGER DEFAULT 0 NOT NULL, is_provisional INTEGER DEFAULT 0 NOT NULL, demo_expires_at TEXT, claim_acquired_at TEXT, claim_acquisition_token TEXT, claim_acquisition_key_hash TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  // The index is the slug-collision check `organizations_create` relies on, so a
  // fixture without it would report success on a duplicate the real DB rejects.
  `CREATE UNIQUE INDEX organizations_slug_unique ON organizations (slug)`,
  `CREATE TABLE org_memberships (org_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (org_id, user_id))`,
  `CREATE INDEX org_memberships_user_id_idx ON org_memberships (user_id)`,
  `CREATE TABLE apps (id TEXT PRIMARY KEY NOT NULL, organization_id TEXT NOT NULL, name TEXT NOT NULL, key TEXT NOT NULL, description TEXT, create_idempotency_key TEXT, create_request_hash TEXT, create_response TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by TEXT)`,
  `CREATE UNIQUE INDEX apps_org_key_unique ON apps (organization_id, key)`,
  `CREATE UNIQUE INDEX apps_create_idempotency_unique ON apps (organization_id, created_by, create_idempotency_key)`,
  `CREATE TABLE app_deletion_sagas (app_id TEXT PRIMARY KEY NOT NULL, generation_id TEXT NOT NULL, organization_id TEXT, actor_id TEXT, delete_before_ts TEXT, retry_actor_hash TEXT, organization_scope_hash TEXT, phase TEXT NOT NULL CHECK (phase IN ('started', 'd1_deleted', 'complete')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE app_memberships (app_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (app_id, user_id))`,
  `CREATE TABLE environments (id TEXT PRIMARY KEY NOT NULL, app_id TEXT NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL, policy TEXT DEFAULT '{"variantAvailability":"allow","targetingRolloutValue":"allow","enabledState":"allow","startExperimentRun":"allow"}' NOT NULL, config_version INTEGER DEFAULT 0 NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by TEXT)`,
  `CREATE UNIQUE INDEX environments_app_key_unique ON environments (app_id, key)`,
  `CREATE TABLE client_keys (key_id TEXT PRIMARY KEY NOT NULL, app_id TEXT NOT NULL, environment_id TEXT NOT NULL, key_material TEXT NOT NULL, origin_allowlist TEXT, rate_limit_rps INTEGER, revoked_at TEXT, created_at TEXT NOT NULL, created_by TEXT)`,
  `CREATE UNIQUE INDEX client_keys_active_env_unique ON client_keys (app_id, environment_id) WHERE revoked_at IS NULL`,
  `CREATE TABLE api_keys (key_id TEXT PRIMARY KEY NOT NULL, app_id TEXT NOT NULL, environment_id TEXT NOT NULL, key_hash TEXT NOT NULL, scopes TEXT NOT NULL, revoked_at TEXT, last_rotated_at TEXT, created_at TEXT NOT NULL, created_by TEXT)`,
  `CREATE INDEX api_keys_key_hash_idx ON api_keys (key_hash)`,
  `CREATE TABLE flags (id TEXT PRIMARY KEY NOT NULL, app_id TEXT NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL, description TEXT, schema TEXT, default_variant_id TEXT, create_idempotency_key TEXT, create_request_hash TEXT, create_response TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by TEXT, updated_by TEXT, version INTEGER DEFAULT 1 NOT NULL)`,
  `CREATE UNIQUE INDEX flags_app_key_unique ON flags (app_id, key)`,
  `CREATE UNIQUE INDEX flags_create_idempotency_unique ON flags (app_id, created_by, create_idempotency_key)`,
  `CREATE TABLE variants (id TEXT PRIMARY KEY NOT NULL, flag_id TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL, description TEXT, created_at TEXT NOT NULL)`,
  `CREATE UNIQUE INDEX variants_flag_name_unique ON variants (flag_id, name)`,
  `CREATE TABLE flag_configs (id TEXT PRIMARY KEY NOT NULL, app_id TEXT NOT NULL, environment_id TEXT NOT NULL, flag_id TEXT NOT NULL, enabled INTEGER DEFAULT 0 NOT NULL, available_variant_names TEXT NOT NULL, default_variant_id TEXT, rollout TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT, updated_via TEXT, version INTEGER DEFAULT 1 NOT NULL)`,
  `CREATE UNIQUE INDEX flag_configs_flag_env_unique ON flag_configs (flag_id, environment_id)`,
  `CREATE TABLE targeting_rules (id TEXT NOT NULL, app_id TEXT NOT NULL, environment_id TEXT NOT NULL, flag_id TEXT NOT NULL, priority INTEGER NOT NULL, conditions TEXT NOT NULL, segment_id TEXT, variant_id TEXT, percentage_rollout TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, FOREIGN KEY (app_id, segment_id) REFERENCES segments(app_id, id) ON DELETE RESTRICT)`,
  `CREATE UNIQUE INDEX targeting_rules_scope_id_unique ON targeting_rules (app_id, environment_id, flag_id, id)`,
  `CREATE TABLE segments (id TEXT PRIMARY KEY NOT NULL, app_id TEXT NOT NULL, name TEXT NOT NULL, conditions TEXT NOT NULL, description TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE UNIQUE INDEX segments_app_id_id_unique ON segments (app_id, id)`,
  `CREATE TABLE experiments (id TEXT PRIMARY KEY NOT NULL, app_id TEXT NOT NULL, environment_id TEXT NOT NULL, key TEXT NOT NULL, flag_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT, hypothesis TEXT, owner TEXT, tags TEXT DEFAULT '[]' NOT NULL, status TEXT DEFAULT 'draft' NOT NULL, targeting_key_field TEXT NOT NULL, targeting_key_type TEXT NOT NULL, confidence_level REAL DEFAULT 0.95 NOT NULL, default_variant_id TEXT, metrics TEXT NOT NULL, guardrail_metrics TEXT NOT NULL, activation_metric_id TEXT, conversion_window_ms INTEGER DEFAULT 0 NOT NULL, dimensions TEXT NOT NULL, draft_allocation TEXT, draft_salt TEXT, draft_targeting_rules TEXT, draft_segment_ids TEXT, live_run_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by TEXT, updated_by TEXT)`,
  `CREATE UNIQUE INDEX experiments_app_env_key_unique ON experiments (app_id, environment_id, key)`,
  // control_variant_id: added by migration 0015 (SPL-184, Freeze Control
  // identity on the Run). This literal drifted from the real migration set
  // once that column landed on main NOT NULL; kept in sync by hand per the
  // file-header tradeoff (self-contained subset, not migration-derived).
  `CREATE TABLE runs (id TEXT PRIMARY KEY NOT NULL, app_id TEXT NOT NULL, environment_id TEXT NOT NULL, experiment_id TEXT NOT NULL, run_number INTEGER NOT NULL, status TEXT DEFAULT 'running' NOT NULL, targeting_key_field TEXT NOT NULL, targeting_key_type TEXT NOT NULL, salt TEXT NOT NULL, allocation TEXT NOT NULL, variant_set TEXT NOT NULL, control_variant_id TEXT NOT NULL, targeting_rules TEXT NOT NULL, activation_metric_id TEXT, confidence_level REAL NOT NULL, horizon TEXT DEFAULT 'sequential' NOT NULL, target_n INTEGER, sample_size_locked INTEGER, decision_family TEXT NOT NULL, guardrail_decisions TEXT NOT NULL, metric_variance_config TEXT DEFAULT '[]' NOT NULL, config_hash TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, start_reason TEXT, end_reason TEXT, created_at TEXT NOT NULL, created_by TEXT)`,
  `CREATE UNIQUE INDEX runs_experiment_salt_unique ON runs (experiment_id, salt)`,
  `CREATE UNIQUE INDEX runs_experiment_run_number_unique ON runs (experiment_id, run_number)`,
  `CREATE TABLE event_definitions (id TEXT PRIMARY KEY NOT NULL, app_id TEXT NOT NULL, name TEXT NOT NULL, family TEXT NOT NULL, display_name TEXT NOT NULL, description TEXT, state TEXT DEFAULT 'draft' NOT NULL, current_published_version_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by TEXT, updated_by TEXT)`,
  `CREATE UNIQUE INDEX event_definitions_app_name_unique ON event_definitions (app_id, name)`,
  `CREATE TABLE event_definition_versions (id TEXT PRIMARY KEY NOT NULL, app_id TEXT NOT NULL, event_definition_id TEXT NOT NULL, version INTEGER NOT NULL, schema_hash TEXT NOT NULL, entity_type TEXT, fields TEXT NOT NULL, dimensions TEXT NOT NULL, published_at TEXT NOT NULL, published_by TEXT)`,
  `CREATE UNIQUE INDEX event_definition_versions_number_unique ON event_definition_versions (event_definition_id, version)`,
  `CREATE TABLE metrics (id TEXT PRIMARY KEY NOT NULL, app_id TEXT NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL, description TEXT, kind TEXT NOT NULL, event_definition_id TEXT, event_field_name TEXT, numerator_metric_id TEXT, denominator_metric_id TEXT, downside_threshold_pct REAL, winsorize INTEGER, winsorize_pct REAL, cuped INTEGER, cuped_coverage_threshold_pct REAL, created_at TEXT NOT NULL, created_by TEXT)`,
  `CREATE UNIQUE INDEX metrics_app_key_unique ON metrics (app_id, key)`,
  `CREATE TABLE approval_requests (id TEXT PRIMARY KEY NOT NULL, app_id TEXT NOT NULL, operation TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL, target_version TEXT NOT NULL, policy_contexts TEXT NOT NULL, diff TEXT NOT NULL, status TEXT NOT NULL, proposed_by TEXT NOT NULL, proposed_via TEXT NOT NULL, proposed_at TEXT NOT NULL, resolved_at TEXT, resulting_target_version TEXT, resulting_resource_type TEXT, resulting_resource_id TEXT, idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL)`,
  `CREATE UNIQUE INDEX approval_requests_actor_idempotency_unique ON approval_requests (app_id, proposed_by, idempotency_key)`,
  `CREATE TABLE approval_reviews (id TEXT PRIMARY KEY NOT NULL, app_id TEXT NOT NULL, approval_request_id TEXT NOT NULL, action TEXT NOT NULL, outcome TEXT NOT NULL, reviewed_by TEXT NOT NULL, reviewed_via TEXT NOT NULL, reviewed_at TEXT NOT NULL, reason TEXT, idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, resulting_target_version TEXT, resulting_resource_type TEXT, resulting_resource_id TEXT, error_code TEXT, error_details TEXT, target_state TEXT)`,
  `CREATE UNIQUE INDEX approval_reviews_actor_idempotency_unique ON approval_reviews (approval_request_id, reviewed_by, idempotency_key)`,
  `CREATE TABLE privacy_requests (request_id TEXT PRIMARY KEY NOT NULL, org_id TEXT NOT NULL, app_id TEXT, request_type TEXT NOT NULL, subject_type TEXT NOT NULL, subject_ref TEXT NOT NULL, subject_ref_redacted_at TEXT, requested_by TEXT NOT NULL, status TEXT NOT NULL, received_at TEXT NOT NULL, ack_due_at TEXT NOT NULL, response_due_at TEXT NOT NULL, completed_at TEXT, denial_reason TEXT, result_json TEXT)`,
  `CREATE TABLE entity_deletions (app_id TEXT NOT NULL, id_type TEXT NOT NULL, targeting_key_hash TEXT NOT NULL, delete_before_ts TEXT NOT NULL, requested_at TEXT NOT NULL, completed_at TEXT, PRIMARY KEY (app_id, id_type, targeting_key_hash, delete_before_ts))`,
  // App teardown deletes from every one of these, so the fixture carries them
  // even though no handler here writes one. The flag-change-log triggers are
  // deliberately absent: @splitch/db's suite owns proving those fire.
  `CREATE TABLE convex_installations (installation_id TEXT PRIMARY KEY NOT NULL, app_id TEXT NOT NULL, environment_id TEXT NOT NULL, callback_url TEXT NOT NULL, secret_ciphertext TEXT NOT NULL, secret_key_version TEXT NOT NULL, secret_fingerprint TEXT NOT NULL, last_rotation_id TEXT, last_rotation_fingerprint TEXT, status TEXT NOT NULL CHECK (status IN ('active', 'revoked')), last_delivered_version INTEGER, last_delivered_at TEXT, latest_delivery_error_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revoked_at TEXT)`,
  `CREATE TABLE config_webhook_deliveries (delivery_id TEXT PRIMARY KEY NOT NULL, installation_id TEXT NOT NULL, app_id TEXT NOT NULL, environment_id TEXT NOT NULL, environment_version INTEGER NOT NULL, body_json TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('pending', 'leased', 'delivered', 'terminal', 'suppressed')), attempt_count INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL, lease_owner TEXT, lease_expires_at TEXT, last_error_json TEXT, created_at TEXT NOT NULL, delivered_at TEXT)`,
  `CREATE TABLE cloudflare_installations (installation_id TEXT PRIMARY KEY NOT NULL, app_id TEXT NOT NULL, environment_id TEXT NOT NULL, endpoint TEXT NOT NULL, secret_ciphertext TEXT NOT NULL, secret_key_version TEXT NOT NULL, secret_fingerprint TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('active', 'revoked')), last_applied_version INTEGER, last_applied_at TEXT, latest_delivery_error_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revoked_at TEXT)`,
  `CREATE TABLE cloudflare_config_deliveries (delivery_id TEXT PRIMARY KEY NOT NULL, installation_id TEXT NOT NULL, app_id TEXT NOT NULL, environment_id TEXT NOT NULL, environment_version INTEGER NOT NULL, state TEXT NOT NULL CHECK (state IN ('pending', 'leased', 'delivered', 'terminal', 'suppressed')), attempt_count INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL, lease_owner TEXT, lease_expires_at TEXT, last_error_json TEXT, created_at TEXT NOT NULL, delivered_at TEXT)`,
  `CREATE TABLE flag_change_events (seq INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, app_id TEXT NOT NULL, environment_id TEXT, flag_id TEXT NOT NULL, flag_key TEXT NOT NULL, action TEXT NOT NULL CHECK (action IN ('created', 'updated', 'deleted')), target_type TEXT NOT NULL CHECK (target_type IN ('flag', 'flag_config', 'variant', 'targeting_rule', 'run')), actor_ref TEXT, actor_via TEXT, changed_at TEXT NOT NULL, diff_json TEXT)`,
  `CREATE TABLE sentry_installations (installation_id TEXT PRIMARY KEY NOT NULL, app_id TEXT NOT NULL, environment_id TEXT NOT NULL, webhook_url TEXT NOT NULL, secret_ciphertext TEXT NOT NULL, secret_key_version TEXT NOT NULL, secret_fingerprint TEXT NOT NULL, last_rotation_id TEXT, last_rotation_fingerprint TEXT, status TEXT NOT NULL CHECK (status IN ('active', 'revoked')), last_delivered_seq INTEGER, last_delivered_at TEXT, attempt_count INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL, latest_delivery_error_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revoked_at TEXT)`,
  `CREATE UNIQUE INDEX sentry_installations_active_scope_unique ON sentry_installations (app_id, environment_id) WHERE status = 'active'`,
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
  // One batch, not a loop of `exec`: Miniflare's D1 is a real workerd process
  // over loopback and each `exec` burns an ephemeral port that lands in
  // TIME_WAIT, which is how this suite used to exhaust the port range.
  await d1.batch(SCHEMA.map((statement) => d1.prepare(statement)));
  return { d1, kv, credentialKv, dispose: () => mf.dispose() };
}

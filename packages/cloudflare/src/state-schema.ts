export const STATE_SCHEMA = `
CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
  id INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS integration (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  installation_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  identity_key TEXT NOT NULL,
  snapshot_version INTEGER NOT NULL,
  applied_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS snapshot (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS assignments (
  experiment_id TEXT NOT NULL,
  id_type TEXT NOT NULL,
  targeting_key_hash TEXT NOT NULL,
  run_id TEXT NOT NULL,
  variant TEXT NOT NULL,
  PRIMARY KEY (experiment_id, id_type, targeting_key_hash)
);
CREATE TABLE IF NOT EXISTS evaluation_claims (
  idempotency_key TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS evaluation_claims_created_idx
  ON evaluation_claims (created_at);
CREATE TABLE IF NOT EXISTS exposure_outbox (
  exposure_id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL,
  flag_key TEXT NOT NULL,
  experiment_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  run_config_hash TEXT NOT NULL,
  context_json TEXT,
  variant_name TEXT NOT NULL,
  exposed_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'terminal')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS exposure_outbox_due_idx
  ON exposure_outbox (state, next_attempt_at);
CREATE INDEX IF NOT EXISTS exposure_outbox_terminal_created_idx
  ON exposure_outbox (state, created_at);
CREATE TABLE IF NOT EXISTS push_claims (
  delivery_id TEXT PRIMARY KEY,
  environment_version INTEGER NOT NULL,
  applied_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS push_claims_applied_idx
  ON push_claims (applied_at);
INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (1);
`;

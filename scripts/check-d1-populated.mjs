#!/usr/bin/env node
// d1:migrate:populated — REAL local D1 migration validator against a NON-EMPTY database.
//
// The sibling `check-d1-local.mjs` applies the whole set to an empty D1. That
// cannot catch the failure mode this script exists for: a table REBUILD (the
// `_next` + DROP + RENAME pattern) succeeds on an empty database and fails with
// `FOREIGN KEY constraint failed` the moment one child row exists. Migration
// 0014 shipped exactly that bug and the empty-DB gate went green on it.
//
// So: apply the migrations preceding the rebuild, seed a realistic parent/child
// graph, then apply the rest. A rebuild that cannot run against real data fails
// here, loudly. The repo's own migrations directory is never mutated; wrangler
// runs against a throwaway copy.
//
// A second scenario runs the same set over data the migration must REFUSE: a
// legacy `event_name` that is not a Telemetry Token. That one has to abort, and
// the abort has to name the App and the offending value, because the operator's
// remedy is renaming that Metric's Event before deploying.

import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dbDir = join(repoRoot, "packages", "db");
const D1_BINDING = "DB";
// Bounds a wedged wrangler/workerd process; each call takes seconds when healthy.
const WRANGLER_TIMEOUT_MS = 5 * 60 * 1000;

// The first migration that rebuilds a table referenced by a foreign key. Every
// migration from here on is withheld from the first pass so the seed lands in
// the pre-rebuild schema.
const FIRST_REBUILD_MIGRATION = "0014_organization_slug.sql";

function fail(message) {
  console.error(`✖ d1:migrate:populated: ${message}`);
  process.exit(1);
}

const NOW = "2026-01-01T00:00:00.000Z";

// A parent Organization plus rows that exercise both table rebuilds: the
// Organization FK graph from 0014 and an existing Experiment Run for the 0015
// frozen-Control backfill.
const SEED = [
  `INSERT INTO organizations (id, name, plan, created_at, updated_at)
     VALUES ('org_fk_probe', 'FK Probe', 'free', '${NOW}', '${NOW}')`,
  `INSERT INTO org_memberships (org_id, user_id, role, created_at)
     VALUES ('org_fk_probe', 'user_fk_probe', 'owner', '${NOW}')`,
  `INSERT INTO apps (id, organization_id, name, key, created_at, updated_at)
     VALUES ('app_fk_probe', 'org_fk_probe', 'FK Probe', 'fk-probe', '${NOW}', '${NOW}')`,
  `INSERT INTO apps (id, organization_id, name, key, created_at, updated_at)
     VALUES (
       'app_fk_probe_other', 'org_fk_probe', 'Other FK Probe', 'other-fk-probe', '${NOW}', '${NOW}'
     )`,
  `INSERT INTO environments (id, app_id, key, name, created_at, updated_at)
     VALUES ('env_fk_probe', 'app_fk_probe', 'dev', 'Dev', '${NOW}', '${NOW}')`,
  `INSERT INTO metrics (
     id, app_id, key, name, kind, event_name, event_value_field, created_at, created_by
   )
   VALUES (
     'metric_fk_probe', 'app_fk_probe', 'purchase-revenue', 'Purchase revenue', 'revenue',
     'purchase_completed', 'amount', '${NOW}', 'user_fk_probe'
   )`,
  `INSERT INTO metrics (
     id, app_id, key, name, kind, event_name, event_value_field, created_at, created_by
   )
   VALUES (
     'metric_fk_probe_other', 'app_fk_probe_other', 'purchase-revenue', 'Purchase revenue',
     'revenue', 'purchase_completed', 'total', '${NOW}', 'user_fk_probe'
   )`,
  `INSERT INTO flags (id, app_id, key, name, schema, default_variant_id, created_at, updated_at)
     VALUES (
       'flag_fk_probe', 'app_fk_probe', 'probe-flag', 'Probe Flag', '{"type":"boolean"}',
       'variant_control_fk_probe', '${NOW}', '${NOW}'
     )`,
  `INSERT INTO experiments (
     id, app_id, environment_id, key, flag_id, name, status, targeting_key_field,
     targeting_key_type, confidence_level, default_variant_id, metrics, guardrail_metrics,
     conversion_window_ms, dimensions, created_at, updated_at
   )
   VALUES (
     'experiment_fk_probe', 'app_fk_probe', 'env_fk_probe', 'probe-experiment',
     'flag_fk_probe', 'Probe Experiment', 'ended', 'userId', 'user', 0.95,
     'variant_control_fk_probe', '[]', '[]', 0, '[]', '${NOW}', '${NOW}'
   )`,
  `INSERT INTO runs (
     id, app_id, environment_id, experiment_id, run_number, status, targeting_key_field,
     targeting_key_type, salt, allocation, variant_set, targeting_rules, confidence_level,
     decision_family, guardrail_decisions, config_hash, started_at, ended_at, created_at
   )
   VALUES (
     'run_fk_probe', 'app_fk_probe', 'env_fk_probe', 'experiment_fk_probe', 1, 'ended',
     'userId', 'user', 'salt_fk_probe', '{"control":50,"treatment":50}',
     '[{"id":"variant_control_fk_probe","name":"control","value":false}]', '[]', 0.95,
     '[]', '[]', 'sha256:probe', '${NOW}', '${NOW}', '${NOW}'
   )`,
  `INSERT INTO privacy_requests (
     request_id, org_id, app_id, request_type, subject_type, subject_ref, requested_by,
     status, received_at, ack_due_at, response_due_at)
   VALUES ('pr_fk_probe', 'org_fk_probe', 'app_fk_probe', 'access', 'user',
     'subject_fk_probe', 'user_fk_probe', 'received', '${NOW}', '${NOW}', '${NOW}')`,
];

// A Metric whose legacy Event name carries a space: legal in the old free-text
// column, addressable by nothing in the new contract.
const NON_TOKEN_SEED = [
  `INSERT INTO apps (id, organization_id, name, key, created_at, updated_at)
     VALUES (
       'app_legacy_event_name', 'org_fk_probe', 'Legacy Event Name', 'legacy-event-name',
       '${NOW}', '${NOW}'
     )`,
  `INSERT INTO metrics (
     id, app_id, key, name, kind, event_name, event_value_field, created_at, created_by
   )
   VALUES (
     'metric_legacy_event_name', 'app_legacy_event_name', 'checkout', 'Checkout', 'count',
     'purchase completed', NULL, '${NOW}', 'user_fk_probe'
   )`,
];

// Every legacy `event_name` the new `event_definitions` CHECK constraint refuses.
const NON_TOKEN_NAMES_SQL = `SELECT DISTINCT app_id, event_name FROM metrics
   WHERE event_name IS NOT NULL
     AND NOT (
       length(event_name) BETWEEN 1 AND 64
       AND event_name GLOB '[A-Za-z0-9]*'
       AND event_name NOT GLOB '*[^A-Za-z0-9_.:-]*'
     )
   ORDER BY app_id, event_name`;

/**
 * Applies the pre-rebuild prefix to a throwaway D1, seeds it, then applies the
 * withheld migrations. The final apply result is returned rather than asserted
 * so a caller can demand either a success or a deliberate abort.
 */
function migrate(seed) {
  const sandbox = mkdtempSync(join(tmpdir(), "splitch-d1-populated-"));
  const persistDir = join(sandbox, "persist");
  const sandboxDb = join(sandbox, "db");
  const sandboxMigrations = join(sandboxDb, "migrations");
  const sandboxConfig = join(sandboxDb, "wrangler.jsonc");

  function wrangler(args) {
    return spawnSync(
      "pnpm",
      [
        "exec",
        "wrangler",
        "d1",
        ...args,
        D1_BINDING,
        "--local",
        "--config",
        sandboxConfig,
        "--persist-to",
        persistDir,
      ],
      { cwd: dbDir, encoding: "utf8", timeout: WRANGLER_TIMEOUT_MS },
    );
  }

  function execSql(sql, label) {
    const result = wrangler(["execute", "--command", sql]);
    if (result.signal) {
      fail(
        `${label}: wrangler was killed with ${result.signal} (timed out after ${WRANGLER_TIMEOUT_MS / 60000}m?).`,
      );
    }
    if (result.status !== 0) {
      fail(`${label} failed:\n${result.stderr || result.stdout}`);
    }
    return result.stdout;
  }

  cpSync(join(dbDir, "migrations"), sandboxMigrations, { recursive: true });
  // The config points at ./migrations relative to itself, so copying both keeps
  // wrangler entirely inside the sandbox.
  writeFileSync(sandboxConfig, readFileSync(join(dbDir, "wrangler.jsonc"), "utf8"));

  const deferred = readdirSync(sandboxMigrations)
    .filter((f) => f.endsWith(".sql") && f >= FIRST_REBUILD_MIGRATION)
    .sort();
  if (deferred.length === 0) {
    fail(`no migration at or after ${FIRST_REBUILD_MIGRATION}; this gate needs updating.`);
  }

  const withheld = deferred.map((file) => ({
    file,
    sql: readFileSync(join(sandboxMigrations, file), "utf8"),
  }));
  for (const { file } of withheld) {
    rmSync(join(sandboxMigrations, file));
  }

  const preRebuild = wrangler(["migrations", "apply"]);
  if (preRebuild.status !== 0) {
    fail(`could not apply the pre-rebuild prefix:\n${preRebuild.stderr || preRebuild.stdout}`);
  }

  for (const statement of seed) {
    execSql(statement, "seeding the parent/child graph");
  }

  for (const { file, sql } of withheld) {
    writeFileSync(join(sandboxMigrations, file), sql);
  }

  const apply = wrangler(["migrations", "apply"]);
  return {
    apply,
    execSql,
    dispose: () => rmSync(sandbox, { recursive: true, force: true }),
  };
}

/** What an operator gets when the migration set aborts: wrangler's error, then the cause. */
function abortReport(run) {
  const offenders = run.execSql(NON_TOKEN_NAMES_SQL, "listing non-token legacy Event names");
  return (
    `${run.apply.stderr || run.apply.stdout}\n` +
    "Legacy Metric Event names that are not Telemetry Tokens (rename these Metrics " +
    `before deploying):\n${offenders}`
  );
}

const populated = migrate(SEED);
try {
  if (populated.apply.status !== 0) {
    fail(
      "a migration failed against a POPULATED database. A table rebuild must defer " +
        `foreign keys across its DROP and RENAME:\n${abortReport(populated)}`,
    );
  }

  const violations = populated.execSql("PRAGMA foreign_key_check", "foreign-key check");
  if (violations.includes("org_fk_probe")) {
    fail(`the foreign-key graph did not survive the migration:\n${violations}`);
  }

  const app = populated.execSql(
    "SELECT organization_id FROM apps WHERE id = 'app_fk_probe'",
    "verifying the child App row",
  );
  if (!app.includes("org_fk_probe")) {
    fail(`the child App row lost its Organization reference:\n${app}`);
  }

  const membership = populated.execSql(
    "SELECT org_id FROM org_memberships WHERE user_id = 'user_fk_probe'",
    "verifying the child membership row",
  );
  if (!membership.includes("org_fk_probe")) {
    fail(`the membership row lost its Organization reference:\n${membership}`);
  }

  const slug = populated.execSql(
    "SELECT slug FROM organizations WHERE id = 'org_fk_probe'",
    "verifying the backfill",
  );
  if (!slug.includes("org_fk_probe")) {
    fail(`the slug backfill did not run against the pre-existing row:\n${slug}`);
  }

  const controlVariant = populated.execSql(
    "SELECT control_variant_id FROM runs WHERE id = 'run_fk_probe'",
    "verifying the frozen Control backfill",
  );
  if (!controlVariant.includes("variant_control_fk_probe")) {
    fail(`the frozen Control backfill did not preserve the existing Run:\n${controlVariant}`);
  }

  const migratedMetric = populated.execSql(
    `SELECT m.event_field_name, d.name, d.display_name, d.family,
            d.current_published_version_id
     FROM metrics AS m
     JOIN event_definitions AS d
       ON d.app_id = m.app_id AND d.id = m.event_definition_id
     WHERE m.id = 'metric_fk_probe'`,
    "verifying the Metric Event Definition backfill",
  );
  for (const expected of [
    "amount",
    "purchase_completed",
    "metric",
    "event_definition_version_migrated_6170705f666b5f70726f6265_",
  ]) {
    if (!migratedMetric.includes(expected)) {
      fail(`the Metric lost its Event binding during migration:\n${migratedMetric}`);
    }
  }

  const migratedVersion = populated.execSql(
    `SELECT json_extract(v.fields, '$[0].name') AS field_name
     FROM event_definition_versions AS v
     JOIN metrics AS m ON m.event_definition_id = v.event_definition_id
     WHERE m.id = 'metric_fk_probe'`,
    "verifying the published Event Definition Version backfill",
  );
  if (!migratedVersion.includes('"field_name": "amount"')) {
    fail(`the published Event Definition Version lost the Metric field:\n${migratedVersion}`);
  }

  const tenantBindings = populated.execSql(
    `SELECT m.id AS metric_id, m.app_id AS metric_app_id,
            d.id AS definition_id, d.app_id AS definition_app_id
     FROM metrics AS m
     JOIN event_definitions AS d
       ON d.id = m.event_definition_id AND d.app_id = m.app_id
     WHERE m.id IN ('metric_fk_probe', 'metric_fk_probe_other')
     ORDER BY m.id`,
    "verifying App-scoped Metric Event Definition backfills",
  );
  for (const expected of [
    "metric_fk_probe_other",
    "app_fk_probe_other",
    "event_definition_migrated_6170705f666b5f70726f6265_",
    "event_definition_migrated_6170705f666b5f70726f62655f6f74686572_",
  ]) {
    if (!tenantBindings.includes(expected)) {
      fail(`Apps sharing an Event name lost distinct Event Definitions:\n${tenantBindings}`);
    }
  }

  console.log(
    "✔ d1:migrate:populated: full migration set preserved a populated Metric Event binding.",
  );
} finally {
  populated.dispose();
}

// A legacy `event_name` outside the Telemetry Token shape has no representation
// in the hot-config key, the ingest contract or the analysis pipes. Admitting it
// would break the Event Definition list for the whole App at read time, so the
// migration has to refuse it at deploy time instead.
const legacyName = migrate([...SEED, ...NON_TOKEN_SEED]);
try {
  if (legacyName.apply.status === 0) {
    fail(
      "the migration admitted a legacy event_name that is not a Telemetry Token; " +
        "it must abort so the Metric is renamed before deploy.",
    );
  }
  const report = abortReport(legacyName);
  for (const expected of ["app_legacy_event_name", "purchase completed"]) {
    if (!report.includes(expected)) {
      fail(`the migration aborted without naming the offending Metric Event:\n${report}`);
    }
  }
  console.log(
    "✔ d1:migrate:populated: a non-token legacy event_name aborted the migration by name.",
  );
} finally {
  legacyName.dispose();
}

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

import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dbDir = join(repoRoot, "packages", "db");
const D1_BINDING = "DB";

// The first migration that rebuilds a table referenced by a foreign key. Every
// migration from here on is withheld from the first pass so the seed lands in
// the pre-rebuild schema.
const FIRST_REBUILD_MIGRATION = "0014_organization_slug.sql";

function fail(message) {
  console.error(`✖ d1:migrate:populated: ${message}`);
  process.exit(1);
}

const NOW = "2026-01-01T00:00:00.000Z";

// A parent Organization plus one row in each table that references it. These are
// the FKs that make `DROP TABLE organizations` fail on a populated D1.
const SEED = [
  `INSERT INTO organizations (id, name, plan, created_at, updated_at)
     VALUES ('org_fk_probe', 'FK Probe', 'free', '${NOW}', '${NOW}')`,
  `INSERT INTO org_memberships (org_id, user_id, role, created_at)
     VALUES ('org_fk_probe', 'user_fk_probe', 'owner', '${NOW}')`,
  `INSERT INTO apps (id, organization_id, name, key, created_at, updated_at)
     VALUES ('app_fk_probe', 'org_fk_probe', 'FK Probe', 'fk-probe', '${NOW}', '${NOW}')`,
  `INSERT INTO privacy_requests (
     request_id, org_id, app_id, request_type, subject_type, subject_ref, requested_by,
     status, received_at, ack_due_at, response_due_at)
   VALUES ('pr_fk_probe', 'org_fk_probe', 'app_fk_probe', 'access', 'user',
     'subject_fk_probe', 'user_fk_probe', 'received', '${NOW}', '${NOW}', '${NOW}')`,
];

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
    { cwd: dbDir, encoding: "utf8" },
  );
}

function execSql(sql, label) {
  const result = wrangler(["execute", "--command", sql]);
  if (result.status !== 0) {
    fail(`${label} failed:\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

try {
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

  for (const statement of SEED) {
    execSql(statement, "seeding the parent/child graph");
  }

  for (const { file, sql } of withheld) {
    writeFileSync(join(sandboxMigrations, file), sql);
  }

  const apply = wrangler(["migrations", "apply"]);
  if (apply.status !== 0) {
    fail(
      "a migration failed against a POPULATED database. A table rebuild must defer " +
        `foreign keys across its DROP and RENAME:\n${apply.stderr || apply.stdout}`,
    );
  }

  const violations = execSql("PRAGMA foreign_key_check", "foreign-key check");
  if (violations.includes("org_fk_probe")) {
    fail(`the foreign-key graph did not survive the migration:\n${violations}`);
  }

  const app = execSql(
    "SELECT organization_id FROM apps WHERE id = 'app_fk_probe'",
    "verifying the child App row",
  );
  if (!app.includes("org_fk_probe")) {
    fail(`the child App row lost its Organization reference:\n${app}`);
  }

  const membership = execSql(
    "SELECT org_id FROM org_memberships WHERE user_id = 'user_fk_probe'",
    "verifying the child membership row",
  );
  if (!membership.includes("org_fk_probe")) {
    fail(`the membership row lost its Organization reference:\n${membership}`);
  }

  const slug = execSql(
    "SELECT slug FROM organizations WHERE id = 'org_fk_probe'",
    "verifying the backfill",
  );
  if (!slug.includes("org_fk_probe")) {
    fail(`the slug backfill did not run against the pre-existing row:\n${slug}`);
  }

  console.log(
    "✔ d1:migrate:populated: full migration set applied cleanly to a POPULATED local D1.",
  );
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

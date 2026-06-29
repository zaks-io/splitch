#!/usr/bin/env node
// d1:migrate:local — REAL local D1 migration validator (SPL-9).
//
// Applies the full @splitch/db Drizzle migration set to a LOCAL Miniflare D1 via
// `wrangler d1 migrations apply --local`. This is a fail-loud gate: a malformed
// or duplicate-column migration makes wrangler exit non-zero and this script
// propagates that code. It NEVER prints-and-exits-0 to paper over a bad set.
//
// Each run applies against a FRESH throwaway persist dir so the entire set is
// re-executed every time. Reusing a persisted DB would let wrangler report
// "no migrations to apply" and silently mask a freshly broken migration.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dbDir = join(repoRoot, "packages", "db");
const configPath = join(dbDir, "wrangler.jsonc");
const migrationsDir = join(dbDir, "migrations");
const D1_BINDING = "DB";

function fail(message) {
  console.error(`✖ d1:migrate:local: ${message}`);
  process.exit(1);
}

if (!existsSync(configPath)) {
  fail(`missing wrangler config at ${configPath}. The D1 schema package must own it.`);
}

const hasMigrationSql =
  existsSync(migrationsDir) && readdirSync(migrationsDir).some((f) => f.endsWith(".sql"));
if (!hasMigrationSql) {
  fail(
    `no .sql migrations found in ${migrationsDir}. Run \`pnpm --filter @splitch/db db:generate\`.`,
  );
}

const persistDir = mkdtempSync(join(tmpdir(), "splitch-d1-"));
try {
  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "wrangler",
      "d1",
      "migrations",
      "apply",
      D1_BINDING,
      "--local",
      "--config",
      configPath,
      "--persist-to",
      persistDir,
    ],
    { cwd: dbDir, stdio: "inherit" },
  );

  if (result.error) {
    fail(`failed to launch wrangler: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`wrangler exited ${result.status}. A migration did not apply cleanly.`);
  }
  console.log("✔ d1:migrate:local: full migration set applied cleanly to local D1.");
} finally {
  rmSync(persistDir, { recursive: true, force: true });
}

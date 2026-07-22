#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCleanupSql, buildSeedSql } from "./seed-shared-preview-smoke-sql.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dbDir = join(repoRoot, "packages", "db");
const configPath = join(dbDir, "wrangler.jsonc");
const now = new Date().toISOString();
const seedTimeoutMs = 60_000;
const cleanupOnly = process.argv.includes("--cleanup-transient");

const cleanupSql = buildCleanupSql();
const seedSql = buildSeedSql(now);
const sql = cleanupOnly ? cleanupSql : `${cleanupSql}\n${seedSql}`;

const tempDir = mkdtempSync(join(tmpdir(), "splitch-smoke-seed-"));
const sqlPath = join(tempDir, "seed.sql");

try {
  writeFileSync(sqlPath, sql);
  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "wrangler",
      "d1",
      "execute",
      "DB",
      "--remote",
      "--env",
      "shared-preview",
      "--config",
      configPath,
      "--file",
      sqlPath,
    ],
    { cwd: repoRoot, stdio: "inherit", timeout: seedTimeoutMs },
  );

  if (result.error && result.error.code !== "ETIMEDOUT") {
    throw result.error;
  }
  if (result.error?.code === "ETIMEDOUT" || result.signal === "SIGTERM") {
    throw new Error(
      `seed-shared-preview-smoke: wrangler d1 execute timed out after ${seedTimeoutMs}ms`,
    );
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  console.log(
    cleanupOnly
      ? "seed-shared-preview-smoke: removed transient shared-preview smoke Apps"
      : "seed-shared-preview-smoke: seeded shared-preview smoke Organization/App/Flag",
  );

  if (!cleanupOnly) {
    const backfill = spawnSync("pnpm", ["credential-cache:backfill:shared-preview"], {
      cwd: repoRoot,
      stdio: "inherit",
      timeout: seedTimeoutMs,
    });
    if (backfill.status !== 0) {
      throw new Error(
        `seed-shared-preview-smoke: credential cache backfill failed with exit ${backfill.status ?? "unknown"}`,
      );
    }
  }
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

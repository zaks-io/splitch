#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { executeSharedPreviewSql } from "./lib/shared-preview-d1.mjs";
import { buildCleanupSql, buildSeedSql } from "./seed-shared-preview-smoke-sql.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const seedTimeoutMs = 60_000;
const cleanupOnly = process.argv.includes("--cleanup-transient");

const cleanupSql = buildCleanupSql();
const seedSql = buildSeedSql(new Date().toISOString());
const status = executeSharedPreviewSql(cleanupOnly ? cleanupSql : `${cleanupSql}\n${seedSql}`, {
  timeoutMs: seedTimeoutMs,
});
if (status !== 0) {
  process.exit(status);
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

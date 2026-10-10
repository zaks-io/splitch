#!/usr/bin/env node
import { executeSharedPreviewSql } from "./lib/shared-preview-d1.mjs";
import { buildCleanupSql, buildSeedSql } from "./seed-shared-preview-smoke-sql.mjs";

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

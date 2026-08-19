/** Applies SQL to the shared-preview D1 database through wrangler. */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DEFAULT_TIMEOUT_MS = 60_000;

export function executeSharedPreviewSql(sql, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const repoRoot = resolve(import.meta.dirname, "..", "..");
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
        join(repoRoot, "packages", "db", "wrangler.jsonc"),
        "--file",
        sqlPath,
      ],
      { cwd: repoRoot, stdio: "inherit", timeout: timeoutMs },
    );

    if (result.error && result.error.code !== "ETIMEDOUT") {
      throw result.error;
    }
    if (result.error?.code === "ETIMEDOUT" || result.signal === "SIGTERM") {
      throw new Error(`shared-preview D1: wrangler d1 execute timed out after ${timeoutMs}ms`);
    }
    return result.status ?? 1;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

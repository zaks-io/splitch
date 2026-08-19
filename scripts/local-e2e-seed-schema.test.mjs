import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { LOCAL_E2E_D1_SEED } from "./local-e2e-fixtures.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const D1_CONFIG = join("packages", "db", "wrangler.jsonc");
// Bounds a wedged wrangler/workerd process; each call takes seconds when healthy.
const WRANGLER_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Applies every migration in packages/db/migrations to a throwaway local D1,
 * then executes exactly the seed scripts/local-e2e-fleet.mjs boots the fleet
 * with. A column a migration dropped or renamed makes this INSERT fail here
 * with SQLite's own "no column named" error -- the same failure the e2e fleet
 * hits at boot -- rather than a hand-copied snapshot of column names that
 * would just drift again the next time a migration touches the same table.
 */
function applySeedToMigratedD1() {
  const sandbox = mkdtempSync(join(tmpdir(), "splitch-e2e-seed-schema-"));
  try {
    const migrate = spawnSync(
      "pnpm",
      [
        "exec",
        "wrangler",
        "d1",
        "migrations",
        "apply",
        "DB",
        "--local",
        "--config",
        D1_CONFIG,
        "--persist-to",
        sandbox,
      ],
      { cwd: repoRoot, encoding: "utf8", timeout: WRANGLER_TIMEOUT_MS },
    );
    assert.equal(
      migrate.status,
      0,
      `applying migrations to the throwaway D1 failed:\n${migrate.stdout}${migrate.stderr}`,
    );

    return spawnSync(
      "pnpm",
      [
        "exec",
        "wrangler",
        "d1",
        "execute",
        "DB",
        "--local",
        "--config",
        D1_CONFIG,
        "--persist-to",
        sandbox,
        "--command",
        LOCAL_E2E_D1_SEED,
      ],
      { cwd: repoRoot, encoding: "utf8", timeout: WRANGLER_TIMEOUT_MS },
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

test("the local e2e D1 seed applies cleanly against every migration's real schema", () => {
  const seeded = applySeedToMigratedD1();
  assert.equal(
    seeded.status,
    0,
    `the seed's INSERTs drifted from the migrated schema:\n${seeded.stdout}${seeded.stderr}`,
  );
});

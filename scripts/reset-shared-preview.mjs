#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createResetPlan,
  SHARED_PREVIEW_TARGET as TARGET,
} from "./lib/shared-preview-reset-plan.mjs";

const TINYBIRD_BRANCH = "shared_preview";
const COPY_PIPE = "cp_deduped_exposures";
const SYSTEM_D1_TABLE_PREFIXES = ["_cf_", "d1_", "sqlite_"];
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function runReset(
  plan,
  { command = runCommand, now = () => new Date().toISOString() } = {},
) {
  requireEnvironment(["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "TB_TOKEN", "TB_HOST"]);
  command("tb", ["--no-version-warning", "branch", "rm", TINYBIRD_BRANCH, "--yes"]);
  command("tb", [
    "--no-version-warning",
    "branch",
    "create",
    TINYBIRD_BRANCH,
    "--last-partition",
    "--wait",
  ]);
  command("tb", ["--no-version-warning", `--branch=${TINYBIRD_BRANCH}`, "build"]);
  command(
    "pnpm",
    [
      "exec",
      "wrangler",
      "d1",
      "migrations",
      "apply",
      "DB",
      "--remote",
      "--env",
      TARGET,
      "--config",
      plan.dbConfigPath,
    ],
    { cwd: plan.dbDir },
  );

  const tables = listResettableD1Tables(plan, command);
  if (tables.length > 0) {
    command(
      "pnpm",
      [
        "exec",
        "wrangler",
        "d1",
        "execute",
        "DB",
        "--remote",
        "--env",
        TARGET,
        "--config",
        plan.dbConfigPath,
        "--command",
        resetSql(tables),
      ],
      { cwd: plan.dbDir },
    );
    assertEmptyD1Tables(plan, tables, command);
  }

  for (const namespaceId of plan.kvIds) {
    for (const key of listKvKeys(namespaceId, command)) {
      command("pnpm", [
        "exec",
        "wrangler",
        "kv",
        "key",
        "delete",
        key,
        "--remote",
        "--namespace-id",
        namespaceId,
      ]);
    }
    if (listKvKeys(namespaceId, command).length > 0) {
      throw new Error(`shared-preview KV ${namespaceId} still contains keys after reset`);
    }
  }

  command("pnpm", ["shared-preview:seed-smoke"]);
  command("tb", [
    "--no-version-warning",
    `--branch=${TINYBIRD_BRANCH}`,
    "copy",
    "run",
    COPY_PIPE,
    "--wait",
    "--yes",
    "--param",
    `copy_watermark_ts=${now()}`,
  ]);
}

function listResettableD1Tables(plan, command) {
  const result = command(
    "pnpm",
    [
      "exec",
      "wrangler",
      "d1",
      "execute",
      "DB",
      "--remote",
      "--env",
      TARGET,
      "--config",
      plan.dbConfigPath,
      "--command",
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ],
    { cwd: plan.dbDir, capture: true },
  );
  return readD1Rows(result.stdout)
    .map((row) => row.name)
    .filter((name) => typeof name === "string")
    .filter((name) => !SYSTEM_D1_TABLE_PREFIXES.some((prefix) => name.startsWith(prefix)))
    .map((name) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new Error(`shared-preview D1 returned an unsafe table name: ${name}`);
      }
      return name;
    });
}

function readD1Rows(output) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("shared-preview D1 table listing returned invalid JSON");
  }
  const rows = Array.isArray(parsed)
    ? parsed.flatMap((entry) => entry?.results ?? [])
    : (parsed?.results ?? []);
  if (!Array.isArray(rows))
    throw new Error("shared-preview D1 table listing returned no result rows");
  return rows;
}

function resetSql(tables) {
  return [
    "BEGIN",
    "PRAGMA defer_foreign_keys = ON",
    ...tables.map((table) => `DELETE FROM "${table}"`),
    "COMMIT",
  ].join(";\n");
}

function assertEmptyD1Tables(plan, tables, command) {
  for (const table of tables) {
    const result = command(
      "pnpm",
      [
        "exec",
        "wrangler",
        "d1",
        "execute",
        "DB",
        "--remote",
        "--env",
        TARGET,
        "--config",
        plan.dbConfigPath,
        "--command",
        `SELECT COUNT(*) AS count FROM "${table}"`,
      ],
      { cwd: plan.dbDir, capture: true },
    );
    const [row] = readD1Rows(result.stdout);
    if (Number(row?.count) !== 0) {
      throw new Error(`shared-preview D1 table ${table} still contains rows after reset`);
    }
  }
}

function listKvKeys(namespaceId, command) {
  const result = command(
    "pnpm",
    ["exec", "wrangler", "kv", "key", "list", "--remote", "--namespace-id", namespaceId],
    { capture: true },
  );
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(`shared-preview KV ${namespaceId} key listing returned invalid JSON`);
  }
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry?.name === "string")) {
    throw new Error(`shared-preview KV ${namespaceId} key listing returned an invalid payload`);
  }
  return parsed.map((entry) => entry.name);
}

function requireEnvironment(names) {
  const missing = names.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`shared-preview reset requires: ${missing.join(", ")}`);
  }
}

function runCommand(command, args, { cwd, capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: capture ? "utf8" : undefined,
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    env: { ...process.env, TB_CLI_TELEMETRY_OPTOUT: "1", TB_VERSION_WARNING: "0" },
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? 1}`);
  return result;
}

function fail(error) {
  console.error(`shared-preview:reset: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runReset(createResetPlan(repoRoot));
  } catch (error) {
    fail(error);
  }
}

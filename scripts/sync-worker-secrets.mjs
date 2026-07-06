import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseWranglerConfigFile } from "./lib/wrangler-config.mjs";

const target = process.argv[2];
const requireEnv =
  process.env.SPLITCH_REQUIRE_WORKER_SECRET_ENV === "1" || process.argv.includes("--require-env");

if (!target) {
  fail("usage: node scripts/sync-worker-secrets.mjs <wrangler-env> [--require-env]");
}

const appsDir = "apps";
const missing = [];

for (const entry of readdirSync(appsDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;

  const appDir = join(appsDir, entry.name);
  const configPath = join(appDir, "wrangler.jsonc");
  let config;
  try {
    config = parseWranglerConfigFile(configPath);
  } catch (error) {
    if (error.code === "ENOENT") continue;
    throw error;
  }

  const required = requiredSecrets(config, target);
  if (required.length === 0) continue;

  const existing = requireEnv ? new Set() : listExistingSecrets(appDir, target);
  const values = {};
  for (const name of required) {
    const value = process.env[name];
    if (value) {
      values[name] = value;
      continue;
    }
    if (!requireEnv && existing.has(name)) {
      continue;
    }
    missing.push(`${appDir}:${target}:${name}`);
  }

  if (Object.keys(values).length > 0) {
    syncSecrets(appDir, target, values);
  }
}

if (missing.length > 0) {
  fail(`missing required Worker secrets:\n${missing.map((name) => `- ${name}`).join("\n")}`);
}

function requiredSecrets(config, envName) {
  const targetConfig = config.env?.[envName];
  const names = targetConfig?.secrets?.required ?? config.secrets?.required ?? [];
  return [...new Set(names)].sort();
}

function listExistingSecrets(cwd, envName) {
  const result = spawnSync("pnpm", ["exec", "wrangler", "secret", "list", "--env", envName], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    return new Set();
  }

  try {
    const parsed = JSON.parse(result.stdout);
    return new Set(parsed.map((secret) => secret.name));
  } catch {
    return new Set();
  }
}

function syncSecrets(cwd, envName, values) {
  const tempDir = mkdtempSync(join(tmpdir(), "splitch-worker-secrets-"));
  const secretsFile = join(tempDir, "secrets.json");
  let exitCode = 0;

  try {
    writeFileSync(secretsFile, JSON.stringify(values), { mode: 0o600 });

    const result = spawnSync(
      "pnpm",
      ["exec", "wrangler", "versions", "secret", "bulk", secretsFile, "--env", envName],
      {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "inherit", "inherit"],
      },
    );

    exitCode = result.status ?? 1;
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }

  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

function fail(message) {
  console.error(`sync-worker-secrets: ${message}`);
  process.exit(1);
}

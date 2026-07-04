import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseConfigFileTextToJson } from "typescript";

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
    config = readWranglerConfig(configPath);
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

function readWranglerConfig(path) {
  const parsed = parseConfigFileTextToJson(path, readFileSync(path, "utf8"));
  if (parsed.error) {
    throw new Error(`${path}: ${parsed.error.messageText}`);
  }
  return parsed.config;
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
  const result = spawnSync("pnpm", ["exec", "wrangler", "secret", "bulk", "--env", envName], {
    cwd,
    encoding: "utf8",
    input: JSON.stringify(values),
    stdio: ["pipe", "inherit", "inherit"],
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function fail(message) {
  console.error(`sync-worker-secrets: ${message}`);
  process.exit(1);
}

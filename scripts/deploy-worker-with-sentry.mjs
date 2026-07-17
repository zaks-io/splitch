import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertNoPlaceholderHostedBindings,
  assertHostedAuthOrigins,
  isHostedWranglerEnv,
  requireHostedWranglerEnvTarget,
} from "./lib/hosted-bindings.mjs";
import { parseWranglerConfigFile } from "./lib/wrangler-config.mjs";

const OUT_DIR = ".wrangler/sentry";
const REQUIRE_SENTRY_ENV = process.env.SPLITCH_REQUIRE_SENTRY_SOURCE_MAP_ENV === "1";
const REQUIRE_WORKER_SECRET_ENV = process.env.SPLITCH_REQUIRE_WORKER_SECRET_ENV === "1";
const args = process.argv.slice(2).filter((arg) => arg !== "--");
const isDryRun = args.includes("--dry-run");
const cloudflareEnv = resolvedCloudflareEnv(args, process.env);
const wranglerConfig = readWranglerConfig();
validateHostedEnvBindings(wranglerConfig, cloudflareEnv);
const release = resolveRelease();
const missingSentryEnv = missingSentryUploadEnv();
const wranglerArgs = [
  "exec",
  "wrangler",
  "deploy",
  "--outdir",
  OUT_DIR,
  "--upload-source-maps",
  "--var",
  `SENTRY_RELEASE:${release}`,
  ...args,
];

if (!isDryRun && REQUIRE_SENTRY_ENV && missingSentryEnv.length > 0) {
  fail(`missing Sentry source map upload env: ${missingSentryEnv.join(", ")}`);
}

const workerSecrets = isDryRun ? undefined : writeWorkerSecretsFile(cloudflareEnv);
if (workerSecrets) {
  wranglerArgs.push("--secrets-file", workerSecrets.path);
}

let deployExitCode = 0;
try {
  deployExitCode = runForStatus("pnpm", wranglerArgs);
} finally {
  workerSecrets?.cleanup();
}

if (deployExitCode !== 0) {
  process.exit(deployExitCode);
}

if (isDryRun) {
  process.exit(0);
}

uploadSentrySourceMaps(release, missingSentryEnv);

function uploadSentrySourceMaps(releaseName, missing) {
  if (missing.length > 0) {
    console.warn(
      `deploy-worker-with-sentry: missing Sentry source map upload env: ${missing.join(
        ", ",
      )}; skipping Sentry upload`,
    );
    return;
  }

  ensureSentryRelease(releaseName);
  run("pnpm", [
    "exec",
    "sentry-cli",
    "sourcemaps",
    "upload",
    "--org",
    process.env.SENTRY_ORG,
    "--project",
    process.env.SENTRY_PROJECT,
    "--release",
    releaseName,
    "--strip-common-prefix",
    "--validate",
    "--wait-for",
    "60",
    OUT_DIR,
  ]);
}

function ensureSentryRelease(releaseName) {
  const projectArgs = ["--org", process.env.SENTRY_ORG, "--project", process.env.SENTRY_PROJECT];
  const existingRelease = spawnSync(
    "pnpm",
    ["exec", "sentry-cli", "releases", "info", ...projectArgs, "--quiet", releaseName],
    {
      stdio: "ignore",
    },
  );

  if (existingRelease.status === 0) {
    return;
  }

  run("pnpm", ["exec", "sentry-cli", "releases", "new", ...projectArgs, releaseName]);
}

function missingSentryUploadEnv() {
  return ["SENTRY_AUTH_TOKEN", "SENTRY_ORG", "SENTRY_PROJECT"].filter((name) => !process.env[name]);
}

function resolveRelease() {
  if (process.env.SENTRY_RELEASE) {
    return process.env.SENTRY_RELEASE;
  }

  const baseRelease =
    process.env.SENTRY_RELEASE_BASE ||
    commandOutput("pnpm", ["exec", "sentry-cli", "releases", "propose-version"]) ||
    commandOutput("git", ["rev-parse", "HEAD"]);

  if (!baseRelease) {
    fail("could not resolve Sentry release from sentry-cli or git");
  }

  return `${readWorkerName()}@${baseRelease}`;
}

function readWorkerName() {
  const name = wranglerConfig?.name;
  if (typeof name !== "string" || name.length === 0) {
    fail("wrangler.jsonc must declare a Worker name");
  }
  return name;
}

function commandOutput(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) {
    return undefined;
  }
  return result.stdout.trim() || undefined;
}

function writeWorkerSecretsFile(envName) {
  const values = workerSecretValues(envName);
  if (Object.keys(values).length === 0) {
    return undefined;
  }

  const tempDir = mkdtempSync(join(tmpdir(), "splitch-worker-deploy-secrets-"));
  const path = join(tempDir, "secrets.json");
  try {
    writeFileSync(path, JSON.stringify(values), { mode: 0o600 });
  } catch (error) {
    rmSync(tempDir, { force: true, recursive: true });
    throw error;
  }

  return {
    path,
    cleanup() {
      rmSync(tempDir, { force: true, recursive: true });
    },
  };
}

function workerSecretValues(envName) {
  const names = requiredWorkerSecrets(envName);
  const values = {};
  const missing = [];

  for (const name of names) {
    const value = process.env[name];
    if (value) {
      values[name] = value;
      continue;
    }
    if (REQUIRE_WORKER_SECRET_ENV) {
      missing.push(name);
    }
  }

  if (missing.length > 0) {
    fail(`missing Worker secret env: ${missing.join(", ")}`);
  }

  return values;
}

function requiredWorkerSecrets(envName) {
  const targetConfig = envName ? wranglerConfig.env?.[envName] : undefined;
  const names = targetConfig?.secrets?.required ?? wranglerConfig.secrets?.required ?? [];
  return [...new Set(names)].sort();
}

function readWranglerConfig() {
  try {
    return parseWranglerConfigFile(join(process.cwd(), "wrangler.jsonc"));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

function readCloudflareEnv(inputArgs) {
  for (let index = 0; index < inputArgs.length; index += 1) {
    const arg = inputArgs[index];
    if ((arg === "--env" || arg === "-e") && inputArgs[index + 1]) {
      return inputArgs[index + 1];
    }
    if (arg.startsWith("--env=")) {
      return arg.slice("--env=".length);
    }
  }
  return undefined;
}

function resolvedCloudflareEnv(inputArgs, env) {
  const explicitEnv = readCloudflareEnv(inputArgs) ?? env.SPLITCH_GENERATED_WRANGLER_ENV;
  if (explicitEnv) {
    return explicitEnv;
  }

  const hostedEnv = readHostedEnvFromProcessEnv(env);
  if (hostedEnv) {
    fail(
      `hosted deploy target ${hostedEnv} requires --env or SPLITCH_GENERATED_WRANGLER_ENV before deploy`,
    );
  }

  return undefined;
}

function readHostedEnvFromProcessEnv(env) {
  for (const name of ["CLOUDFLARE_ENV", "SPLITCH_PLATFORM_TARGET"]) {
    const value = env[name];
    if (isHostedWranglerEnv(value)) {
      return value;
    }
  }
  return undefined;
}

function validateHostedEnvBindings(config, envName) {
  try {
    const targetConfig = requireHostedWranglerEnvTarget(config, envName, "wrangler.jsonc");
    if (targetConfig) {
      assertNoPlaceholderHostedBindings(targetConfig, `wrangler.jsonc env.${envName}`);
      assertHostedAuthOrigins(
        { ...targetConfig, name: config.name },
        `wrangler.jsonc env.${envName}`,
      );
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

function run(command, commandArgs) {
  const status = runForStatus(command, commandArgs);
  if (status !== 0) {
    process.exit(status);
  }
}

function runForStatus(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { stdio: "inherit" });
  return result.status ?? 1;
}

function fail(message) {
  console.error(`deploy-worker-with-sentry: ${message}`);
  process.exit(1);
}

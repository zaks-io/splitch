import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = new URL("../..", import.meta.url).pathname;
const scriptPath = join(repoRoot, "scripts/deploy-worker-with-sentry.mjs");
export const deployedCommitSha = "a".repeat(40);

export function createFixture({
  requiredSecrets = [],
  bindings = {},
  workerName = "splitch-evaluation-api",
  vars = {},
  targetVars = {},
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "splitch-worker-deploy-test-"));
  const binDir = join(root, "bin");
  const callsPath = join(root, "wrangler-deploy-calls.jsonl");

  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    join(root, "wrangler.jsonc"),
    JSON.stringify({
      name: workerName,
      vars,
      env: {
        production: {
          ...bindings,
          vars: targetVars,
          secrets: {
            required: requiredSecrets,
          },
        },
      },
    }),
  );
  writeFileSync(
    join(binDir, "pnpm"),
    `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require("node:fs");
const args = process.argv.slice(2);
const secretsFileIndex = args.indexOf("--secrets-file");
const secretsFile = secretsFileIndex === -1 ? undefined : args[secretsFileIndex + 1];
appendFileSync(process.env.SPLITCH_FAKE_WRANGLER_CALLS, JSON.stringify({
  cwd: process.cwd(),
  args,
  secretsFile,
  secrets: secretsFile ? JSON.parse(readFileSync(secretsFile, "utf8")) : undefined
}) + "\\n");
if (args[1] === "sentry-cli" && args[2] === "sourcemaps" && args[3] === "upload") {
  const exitCode = Number(process.env.SPLITCH_FAKE_SENTRY_UPLOAD_EXIT || 0);
  if (exitCode !== 0) {
    console.error("error: Failed to process files in 60s");
  }
  process.exit(exitCode);
}
process.exit(Number(process.env.SPLITCH_FAKE_WRANGLER_EXIT || 0));
`,
  );
  chmodSync(join(binDir, "pnpm"), 0o755);

  return { binDir, callsPath, root };
}

export function runDeploy(fixture, args, extraEnv = {}, fakeWranglerExit = "0") {
  const env = {
    ...process.env,
  };
  for (const name of [
    "SENTRY_AUTH_TOKEN",
    "SENTRY_DSN",
    "SENTRY_ORG",
    "SENTRY_PROJECT",
    "SPLITCH_EVENT_INGEST_TOKEN",
    "SPLITCH_DEPLOYED_COMMIT_SHA",
    "TINYBIRD_INGEST_TOKEN",
    "SPLITCH_GENERATED_WRANGLER_ENV",
    "SPLITCH_PLATFORM_TARGET",
    "SPLITCH_REQUIRE_SENTRY_SOURCE_MAP_ENV",
    "SPLITCH_REQUIRE_WORKER_SECRET_ENV",
    "CLOUDFLARE_ENV",
  ]) {
    delete env[name];
  }
  Object.assign(env, {
    PATH: `${fixture.binDir}:${process.env.PATH}`,
    SENTRY_RELEASE: "test-release",
    SPLITCH_DEPLOYED_COMMIT_SHA: deployedCommitSha,
    SPLITCH_FAKE_WRANGLER_CALLS: fixture.callsPath,
    SPLITCH_FAKE_WRANGLER_EXIT: fakeWranglerExit,
  });
  Object.assign(env, extraEnv);

  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: fixture.root,
    encoding: "utf8",
    env,
  });
}

export function readCalls(path) {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

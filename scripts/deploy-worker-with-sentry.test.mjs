import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { PLACEHOLDER_KV_ID } from "./lib/hosted-bindings.mjs";

const repoRoot = new URL("..", import.meta.url).pathname;
const scriptPath = join(repoRoot, "scripts/deploy-worker-with-sentry.mjs");

test("passes required Worker secrets to wrangler deploy as a temporary secrets file", () => {
  const fixture = createFixture({
    requiredSecrets: [
      "SENTRY_DSN",
      "SPLITCH_EVENT_INGEST_TOKEN",
      "TINYBIRD_RAW_EVALUATIONS_INGEST_TOKEN",
    ],
  });

  const result = runDeploy(fixture, ["--env", "production", "--strict"], {
    SENTRY_DSN: "https://example.invalid/1",
    SPLITCH_EVENT_INGEST_TOKEN: "fake-event-ingest-token",
    TINYBIRD_RAW_EVALUATIONS_INGEST_TOKEN: "fake-raw-evaluations-token",
    SPLITCH_REQUIRE_WORKER_SECRET_ENV: "1",
  });

  assert.equal(result.status, 0, result.stderr);

  const [call] = readCalls(fixture.callsPath);
  const secretsFileIndex = call.args.indexOf("--secrets-file");
  assert.notEqual(secretsFileIndex, -1);
  assert.deepEqual(call.args.slice(0, 3), ["exec", "wrangler", "deploy"]);
  assert.deepEqual(call.args.slice(secretsFileIndex + 2), []);
  assert.deepEqual(Object.keys(call.secrets).sort(), [
    "SENTRY_DSN",
    "SPLITCH_EVENT_INGEST_TOKEN",
    "TINYBIRD_RAW_EVALUATIONS_INGEST_TOKEN",
  ]);
  assert.equal(existsSync(call.secretsFile), false);
});

test("omits missing Worker secrets from the deploy secrets file when env values are optional", () => {
  const fixture = createFixture({
    requiredSecrets: ["SENTRY_DSN", "SPLITCH_EVENT_INGEST_TOKEN"],
  });

  const result = runDeploy(fixture, ["--env", "production"], {
    SENTRY_DSN: "https://example.invalid/1",
  });

  assert.equal(result.status, 0, result.stderr);

  const [call] = readCalls(fixture.callsPath);
  const secretsFileIndex = call.args.indexOf("--secrets-file");
  assert.notEqual(secretsFileIndex, -1);
  assert.deepEqual(Object.keys(call.secrets).sort(), ["SENTRY_DSN"]);
  assert.equal(call.secrets.SPLITCH_EVENT_INGEST_TOKEN, undefined);
  assert.equal(existsSync(call.secretsFile), false);
});

test("does not pass Worker secrets during dry-run deploys", () => {
  const fixture = createFixture({ requiredSecrets: ["SENTRY_DSN"] });

  const result = runDeploy(fixture, ["--dry-run", "--env", "production"], {
    SENTRY_DSN: "https://example.invalid/1",
  });

  assert.equal(result.status, 0, result.stderr);

  const [call] = readCalls(fixture.callsPath);
  assert.equal(call.args.includes("--secrets-file"), false);
});

test("removes the deploy secrets file when wrangler deploy fails", () => {
  const fixture = createFixture({ requiredSecrets: ["SENTRY_DSN"] });

  const result = runDeploy(
    fixture,
    ["--env", "production"],
    { SENTRY_DSN: "https://example.invalid/1" },
    "17",
  );

  assert.equal(result.status, 17);

  const [call] = readCalls(fixture.callsPath);
  assert.equal(existsSync(call.secretsFile), false);
});

test("fails before wrangler deploy when CI requires a missing Worker secret", () => {
  const fixture = createFixture({ requiredSecrets: ["SENTRY_DSN"] });

  const result = runDeploy(fixture, ["--env", "production"], {
    SPLITCH_REQUIRE_WORKER_SECRET_ENV: "1",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing Worker secret env: SENTRY_DSN/);
  assert.equal(existsSync(fixture.callsPath), false);
});

test("fails before wrangler deploy when hosted env bindings contain placeholders", () => {
  const fixture = createFixture({
    bindings: {
      kv_namespaces: [{ binding: "SESSION_STORE", id: PLACEHOLDER_KV_ID }],
    },
  });

  const result = runDeploy(fixture, ["--env", "production"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /wrangler\.jsonc env\.production/);
  assert.match(result.stderr, /kv_namespaces\.SESSION_STORE\.id/);
  assert.equal(existsSync(fixture.callsPath), false);
});

test("fails before wrangler deploy when hosted target is implied without a resolved env", () => {
  const fixture = createFixture();

  const result = runDeploy(fixture, ["--dry-run"], {
    SPLITCH_PLATFORM_TARGET: "production",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /hosted deploy target production requires --env/);
  assert.equal(existsSync(fixture.callsPath), false);
});

test("fails before auth Worker deploy when hosted Control Panel origin is missing", () => {
  const fixture = createFixture({
    workerName: "splitch-auth-api",
    vars: { AUTH_API_ORIGIN: "https://auth.example.test" },
  });

  const result = runDeploy(fixture, ["--env", "production"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CONTROL_PANEL_ORIGIN/);
  assert.equal(existsSync(fixture.callsPath), false);
});

for (const missingVerifierBinding of ["WORKOS_JWKS_URI", "WORKOS_ISSUER", "WORKOS_CLIENT_ID"]) {
  test(`fails before auth Worker deploy when ${missingVerifierBinding} is not required`, () => {
    const requiredSecrets = ["WORKOS_JWKS_URI", "WORKOS_ISSUER", "WORKOS_CLIENT_ID"].filter(
      (name) => name !== missingVerifierBinding,
    );
    const fixture = createFixture({
      workerName: "splitch-auth-api",
      targetVars: { CONTROL_PANEL_ORIGIN: "https://app.example.test" },
      requiredSecrets,
    });

    const result = runDeploy(fixture, ["--env", "production"]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(missingVerifierBinding));
    assert.equal(existsSync(fixture.callsPath), false);
  });
}

function createFixture({
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
process.exit(Number(process.env.SPLITCH_FAKE_WRANGLER_EXIT || 0));
`,
  );
  chmodSync(join(binDir, "pnpm"), 0o755);

  return { binDir, callsPath, root };
}

function runDeploy(fixture, args, extraEnv = {}, fakeWranglerExit = "0") {
  const env = {
    ...process.env,
  };
  for (const name of [
    "SENTRY_AUTH_TOKEN",
    "SENTRY_DSN",
    "SENTRY_ORG",
    "SENTRY_PROJECT",
    "SPLITCH_EVENT_INGEST_TOKEN",
    "TINYBIRD_RAW_EVALUATIONS_INGEST_TOKEN",
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

function readCalls(path) {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

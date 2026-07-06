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

const repoRoot = new URL("..", import.meta.url).pathname;
const scriptPath = join(repoRoot, "scripts/deploy-worker-with-sentry.mjs");

test("passes required Worker secrets to wrangler deploy as a temporary secrets file", () => {
  const fixture = createFixture({
    requiredSecrets: ["SENTRY_DSN", "SPLITCH_EVENT_INGEST_TOKEN"],
  });

  const result = runDeploy(fixture, ["--env", "production", "--strict"], {
    SENTRY_DSN: "https://example.invalid/1",
    SPLITCH_EVENT_INGEST_TOKEN: "fake-event-ingest-token",
  });

  assert.equal(result.status, 0, result.stderr);

  const [call] = readCalls(fixture.callsPath);
  const secretsFileIndex = call.args.indexOf("--secrets-file");
  assert.notEqual(secretsFileIndex, -1);
  assert.deepEqual(call.args.slice(0, 3), ["exec", "wrangler", "deploy"]);
  assert.deepEqual(call.args.slice(secretsFileIndex + 2), []);
  assert.deepEqual(Object.keys(call.secrets).sort(), ["SENTRY_DSN", "SPLITCH_EVENT_INGEST_TOKEN"]);
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

  const result = runDeploy(fixture, ["--env", "production"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing Worker secret env: SENTRY_DSN/);
  assert.equal(existsSync(fixture.callsPath), false);
});

function createFixture({ requiredSecrets }) {
  const root = mkdtempSync(join(tmpdir(), "splitch-worker-deploy-test-"));
  const binDir = join(root, "bin");
  const callsPath = join(root, "wrangler-deploy-calls.jsonl");

  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    join(root, "wrangler.jsonc"),
    JSON.stringify({
      name: "splitch-evaluation-api",
      env: {
        production: {
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
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: fixture.root,
    encoding: "utf8",
    env: {
      ...process.env,
      ...extraEnv,
      PATH: `${fixture.binDir}:${process.env.PATH}`,
      SENTRY_RELEASE: "test-release",
      SPLITCH_FAKE_WRANGLER_CALLS: fixture.callsPath,
      SPLITCH_FAKE_WRANGLER_EXIT: fakeWranglerExit,
      SPLITCH_REQUIRE_WORKER_SECRET_ENV: "1",
    },
  });
}

function readCalls(path) {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

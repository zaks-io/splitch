import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const repoRoot = new URL("..", import.meta.url).pathname;
const scriptPath = join(repoRoot, "scripts/sync-worker-secrets.mjs");

test("syncs hosted Worker secrets through Wrangler versions without deploying immediately", () => {
  const fixture = createFixture({
    requiredSecrets: [
      "SENTRY_DSN",
      "SPLITCH_EVENT_INGEST_TOKEN",
      "TINYBIRD_RAW_EVALUATIONS_INGEST_TOKEN",
    ],
  });

  const result = runSync(fixture, {
    SENTRY_DSN: "https://example.invalid/1",
    SPLITCH_EVENT_INGEST_TOKEN: "fake-event-ingest-token",
    TINYBIRD_RAW_EVALUATIONS_INGEST_TOKEN: "fake-raw-evaluations-token",
  });

  assert.equal(result.status, 0, result.stderr);

  const [call] = readCalls(fixture.callsPath);
  assert.deepEqual(call.args.slice(0, 5), ["exec", "wrangler", "versions", "secret", "bulk"]);
  assert.deepEqual(call.args.slice(6), ["--env", "production"]);
  assert.equal(call.cwd, realpathSync(join(fixture.root, "apps/evaluation-api")));
  assert.deepEqual(Object.keys(call.secrets).sort(), [
    "SENTRY_DSN",
    "SPLITCH_EVENT_INGEST_TOKEN",
    "TINYBIRD_RAW_EVALUATIONS_INGEST_TOKEN",
  ]);
  assert.equal(existsSync(call.secretsFile), false);
});

test("fails loud when CI requires a missing Worker secret value", () => {
  const fixture = createFixture({ requiredSecrets: ["SENTRY_DSN"] });

  const result = runSync(fixture);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing required Worker secrets/);
  assert.match(result.stderr, /apps\/evaluation-api:production:SENTRY_DSN/);
  assert.equal(existsSync(fixture.callsPath), false);
});

test("removes the temporary secrets file when Wrangler fails", () => {
  const fixture = createFixture({ requiredSecrets: ["SENTRY_DSN"] });

  const result = runSync(fixture, { SENTRY_DSN: "https://example.invalid/1" }, "17");

  assert.equal(result.status, 17);

  const [call] = readCalls(fixture.callsPath);
  assert.equal(existsSync(call.secretsFile), false);
});

function createFixture({ requiredSecrets }) {
  const root = mkFixtureRoot();
  const appDir = join(root, "apps/evaluation-api");
  const binDir = join(root, "bin");
  const callsPath = join(root, "wrangler-calls.jsonl");

  mkdirSync(appDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    join(appDir, "wrangler.jsonc"),
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
const secretsFile = args[5];
appendFileSync(process.env.SPLITCH_FAKE_WRANGLER_CALLS, JSON.stringify({
  cwd: process.cwd(),
  args,
  secretsFile,
  secrets: JSON.parse(readFileSync(secretsFile, "utf8"))
}) + "\\n");
process.exit(Number(process.env.SPLITCH_FAKE_WRANGLER_EXIT || 0));
`,
  );
  chmodSync(join(binDir, "pnpm"), 0o755);

  return { binDir, callsPath, root };
}

function runSync(fixture, extraEnv = {}, fakeWranglerExit = "0") {
  return spawnSync(process.execPath, [scriptPath, "production"], {
    cwd: fixture.root,
    encoding: "utf8",
    env: {
      ...process.env,
      ...extraEnv,
      PATH: `${fixture.binDir}:${process.env.PATH}`,
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

function mkFixtureRoot() {
  return mkdtempSync(join(tmpdir(), "splitch-secret-sync-test-"));
}

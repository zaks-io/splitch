import assert from "node:assert/strict";
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
import test from "node:test";

const repoRoot = new URL("..", import.meta.url).pathname;
const scriptPath = join(repoRoot, "scripts/deploy-vite-worker-with-sentry.mjs");

test("control-panel deploy scripts use the Vite-aware deploy wrapper", () => {
  const packageJson = JSON.parse(
    readFileSync(join(repoRoot, "apps/control-panel/package.json"), "utf8"),
  );

  assert.equal(packageJson.scripts.deploy, "node ../../scripts/deploy-vite-worker-with-sentry.mjs");
  assert.equal(
    packageJson.scripts["deploy:dry-run"],
    "node ../../scripts/deploy-vite-worker-with-sentry.mjs --dry-run",
  );
});

test("passes CLOUDFLARE_ENV to Vite build and deploys the generated hosted config", () => {
  const fixture = createFixture({
    generatedConfig: hostedGeneratedConfig({
      kvId: "bdfa1197123d4eef945c5a703d63a572",
      d1Id: "f419e372-d548-4afb-966f-40ff298303d8",
    }),
  });

  const result = runDeploy(fixture, ["--dry-run", "--env", "production", "--strict"]);

  assert.equal(result.status, 0, result.stderr);

  const calls = readCalls(fixture.callsPath);
  assert.equal(calls[0].command, "build");
  assert.equal(calls[0].cloudflareEnv, "production");
  assert.equal(calls[0].generatedWranglerEnv, "production");
  assert.deepEqual(calls[1].args.slice(0, 3), ["exec", "wrangler", "deploy"]);
  assert.equal(calls[1].args.includes("--env"), false);
  assert.equal(calls[1].cloudflareEnv, "production");
  assert.equal(calls[1].generatedWranglerEnv, "production");
});

test("fails before deploy when the generated hosted config keeps placeholder bindings", () => {
  const fixture = createFixture({
    generatedConfig: hostedGeneratedConfig({
      kvId: "00000000000000000000000000000000",
      d1Id: "f419e372-d548-4afb-966f-40ff298303d8",
    }),
  });

  const result = runDeploy(fixture, ["--dry-run", "--env", "production"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /generated Wrangler config/);
  assert.match(result.stderr, /kv_namespaces\.SESSION_STORE\.id/);
  assert.equal(readCalls(fixture.callsPath).length, 1);
});

function createFixture({ generatedConfig }) {
  const root = mkdtempSync(join(tmpdir(), "splitch-vite-worker-deploy-test-"));
  const binDir = join(root, "bin");
  const callsPath = join(root, "calls.jsonl");

  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    join(root, "wrangler.jsonc"),
    JSON.stringify({
      name: "splitch-control-panel",
      env: {
        production: {
          kv_namespaces: [{ binding: "SESSION_STORE", id: "bdfa1197123d4eef945c5a703d63a572" }],
          d1_databases: [
            {
              binding: "DB",
              database_name: "splitch-production-d1",
              database_id: "f419e372-d548-4afb-966f-40ff298303d8",
            },
          ],
          secrets: {
            required: ["WORKOS_CLIENT_ID"],
          },
        },
      },
    }),
  );
  writeFileSync(
    join(binDir, "pnpm"),
    `#!/usr/bin/env node
const { appendFileSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const args = process.argv.slice(2);
appendFileSync(process.env.SPLITCH_FAKE_CALLS, JSON.stringify({
  command: args[0],
  args,
  cloudflareEnv: process.env.CLOUDFLARE_ENV,
  generatedWranglerEnv: process.env.SPLITCH_GENERATED_WRANGLER_ENV
}) + "\\n");
if (args[0] === "build") {
  const configPath = join(process.cwd(), "dist/server/wrangler.json");
  mkdirSync(join(process.cwd(), "dist/server"), { recursive: true });
  writeFileSync(configPath, process.env.SPLITCH_GENERATED_WRANGLER_CONFIG);
  process.exit(0);
}
const secretsFileIndex = args.indexOf("--secrets-file");
if (secretsFileIndex !== -1) {
  readFileSync(args[secretsFileIndex + 1], "utf8");
}
process.exit(0);
`,
  );
  chmodSync(join(binDir, "pnpm"), 0o755);

  return { binDir, callsPath, generatedConfig, root };
}

function hostedGeneratedConfig({ kvId, d1Id }) {
  return {
    name: "splitch-control-panel",
    main: "index.js",
    vars: { SPLITCH_PLATFORM_TARGET: "production" },
    kv_namespaces: [{ binding: "SESSION_STORE", id: kvId }],
    d1_databases: [
      {
        binding: "DB",
        database_name: "splitch-production-d1",
        database_id: d1Id,
      },
    ],
  };
}

function runDeploy(fixture, args) {
  const env = {
    ...process.env,
    PATH: `${fixture.binDir}:${process.env.PATH}`,
    SENTRY_RELEASE: "test-release",
    SPLITCH_FAKE_CALLS: fixture.callsPath,
    SPLITCH_GENERATED_WRANGLER_CONFIG: JSON.stringify(fixture.generatedConfig),
    WORKOS_CLIENT_ID: "fake-workos-client-id",
  };

  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: fixture.root,
    encoding: "utf8",
    env,
  });
}

function readCalls(path) {
  if (!existsSync(path)) {
    return [];
  }

  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

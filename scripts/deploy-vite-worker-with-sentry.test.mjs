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
import { PLACEHOLDER_KV_ID } from "./lib/hosted-bindings.mjs";

const repoRoot = new URL("..", import.meta.url).pathname;
const scriptPath = join(repoRoot, "scripts/deploy-vite-worker-with-sentry.mjs");
const deployedCommitSha = "a".repeat(40);

test("control-panel deploy scripts use the Vite-aware deploy wrapper", () => {
  const packageJson = JSON.parse(
    readFileSync(join(repoRoot, "apps/control-panel/package.json"), "utf8"),
  );
  const rootPackageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const turbo = JSON.parse(readFileSync(join(repoRoot, "turbo.json"), "utf8"));

  assert.equal(packageJson.scripts.deploy, "node ../../scripts/deploy-vite-worker-with-sentry.mjs");
  assert.equal(
    packageJson.scripts["deploy:dry-run"],
    "node ../../scripts/deploy-vite-worker-with-sentry.mjs --dry-run",
  );
  assert.deepEqual(turbo.tasks.deploy.dependsOn, ["build"]);
  assert.deepEqual(turbo.globalEnv, ["CI", "NODE_ENV"]);
  assert.equal("env" in turbo.tasks.build, false);
  for (const task of ["@splitch/control-panel#build", "@splitch/marketing#build"]) {
    assert.equal(turbo.tasks[task].env.includes("CLOUDFLARE_ENV"), true);
    assert.equal(turbo.tasks[task].env.includes("SPLITCH_GENERATED_WRANGLER_ENV"), true);
  }
  for (const name of [
    "SENTRY_DSN",
    "AUTH_API_ORIGIN",
    "AUTH_JWKS_URI",
    "CONTROL_PLANE_ORIGIN",
    "TINYBIRD_API_URL",
  ]) {
    assert.equal(
      turbo.tasks["@splitch/control-panel#build"].env.includes(name),
      false,
      `${name} is a runtime input and must not participate in the Control Panel build cache key`,
    );
    assert.equal(
      turbo.globalEnv.includes(name),
      false,
      `${name} must not invalidate every Turbo task`,
    );
  }
  for (const name of [
    "SPLITCH_PLATFORM_TARGET",
    "SENTRY_RELEASE",
    "SENTRY_RELEASE_BASE",
    "VITE_SENTRY_DSN",
    "VITE_SENTRY_RELEASE",
    "VITE_SPLITCH_PLATFORM_TARGET",
  ]) {
    assert.equal(
      turbo.tasks["@splitch/control-panel#build"].env.includes(name),
      true,
      `${name} must participate in the Control Panel build cache key`,
    );
  }
  assert.deepEqual(turbo.tasks["@splitch/marketing#build"].env, [
    "CLOUDFLARE_ENV",
    "SPLITCH_GENERATED_WRANGLER_ENV",
  ]);
  for (const environment of ["production", "shared-preview"]) {
    assert.match(
      rootPackageJson.scripts[`deploy:dry-run:${environment}`],
      new RegExp(`CLOUDFLARE_ENV=${environment} SPLITCH_GENERATED_WRANGLER_ENV=${environment}`),
    );
  }
});

test("deploys the prebuilt generated hosted config without rebuilding it", () => {
  const fixture = createFixture({
    generatedConfig: hostedGeneratedConfig({
      kvId: "bdfa1197123d4eef945c5a703d63a572",
      d1Id: "f419e372-d548-4afb-966f-40ff298303d8",
    }),
  });

  const result = runDeploy(fixture, ["--dry-run", "--env", "production", "--strict"]);

  assert.equal(result.status, 0, result.stderr);

  const calls = readCalls(fixture.callsPath);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(0, 3), ["exec", "wrangler", "deploy"]);
  assert.equal(calls[0].cloudflareEnv, "production");
  assert.equal(calls[0].generatedWranglerEnv, "production");
  assert.equal(calls[0].deployedCommitSha, deployedCommitSha);
  assert.equal(calls[0].args.includes("--env"), false);
  assert.equal(calls[0].args.includes(`SPLITCH_DEPLOYED_COMMIT_SHA:${deployedCommitSha}`), true);
});

test("fails before deploy when the generated hosted config keeps placeholder bindings", () => {
  const fixture = createFixture({
    generatedConfig: hostedGeneratedConfig({
      kvId: PLACEHOLDER_KV_ID,
      d1Id: "f419e372-d548-4afb-966f-40ff298303d8",
    }),
  });

  const result = runDeploy(fixture, ["--dry-run", "--env", "production"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /generated Wrangler config/);
  assert.match(result.stderr, /kv_namespaces\.SESSION_STORE\.id/);
  assert.equal(readCalls(fixture.callsPath).length, 0);
});

test("fails before deploy when the prebuilt config targets another hosted environment", () => {
  const fixture = createFixture({
    generatedConfig: hostedGeneratedConfig({
      target: "production",
      kvId: "bdfa1197123d4eef945c5a703d63a572",
      d1Id: "f419e372-d548-4afb-966f-40ff298303d8",
    }),
  });

  const result = runDeploy(fixture, ["--dry-run", "--env", "shared-preview"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /prebuilt Wrangler config does not match shared-preview/);
  assert.match(result.stderr, /SPLITCH_PLATFORM_TARGET=production/);
  assert.equal(readCalls(fixture.callsPath).length, 0);
});

test("fails before deploy for package deploy invocation without --env when hosted target is selected", () => {
  const fixture = createFixture({
    generatedConfig: hostedGeneratedConfig({
      kvId: PLACEHOLDER_KV_ID,
      d1Id: "f419e372-d548-4afb-966f-40ff298303d8",
    }),
  });

  const result = runDeploy(fixture, ["--dry-run"], { SPLITCH_PLATFORM_TARGET: "production" });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /generated Wrangler config/);
  assert.match(result.stderr, /kv_namespaces\.SESSION_STORE\.id/);

  assert.equal(readCalls(fixture.callsPath).length, 0);
});

test("fails loud when the Turborepo build output is missing", () => {
  const fixture = createFixture({});
  const result = runDeploy(fixture, ["--dry-run", "--env", "production"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing prebuilt Wrangler config/);
  assert.match(result.stderr, /Turborepo task/);
  assert.equal(readCalls(fixture.callsPath).length, 0);
});

function createFixture({ generatedConfig }) {
  const root = mkdtempSync(join(tmpdir(), "splitch-vite-worker-deploy-test-"));
  const binDir = join(root, "bin");
  const callsPath = join(root, "calls.jsonl");

  mkdirSync(binDir, { recursive: true });
  if (generatedConfig) {
    mkdirSync(join(root, "dist/server"), { recursive: true });
    writeFileSync(join(root, "dist/server/wrangler.json"), JSON.stringify(generatedConfig));
  }
  writeFileSync(
    join(root, "wrangler.jsonc"),
    JSON.stringify({
      name: "splitch-control-panel",
      env: {
        "shared-preview": {
          name: "splitch-control-panel-shared-preview",
          vars: { SPLITCH_PLATFORM_TARGET: "shared-preview" },
          kv_namespaces: [{ binding: "SESSION_STORE", id: "673d17e768eb45f5bfc5275fbd0e9320" }],
          d1_databases: [
            {
              binding: "DB",
              database_name: "splitch-shared-preview-d1",
              database_id: "34971683-d76b-4fc0-9bc0-9e97f297fbec",
            },
          ],
          secrets: {
            required: ["WORKOS_CLIENT_ID"],
          },
        },
        production: {
          name: "splitch-control-panel",
          vars: { SPLITCH_PLATFORM_TARGET: "production" },
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
const { appendFileSync, readFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.SPLITCH_FAKE_CALLS, JSON.stringify({
  command: args[0],
  args,
  cloudflareEnv: process.env.CLOUDFLARE_ENV,
  generatedWranglerEnv: process.env.SPLITCH_GENERATED_WRANGLER_ENV,
  deployedCommitSha: process.env.SPLITCH_DEPLOYED_COMMIT_SHA
}) + "\\n");
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

function hostedGeneratedConfig({ target = "production", kvId, d1Id }) {
  return {
    name:
      target === "shared-preview"
        ? "splitch-control-panel-shared-preview"
        : "splitch-control-panel",
    main: "index.js",
    vars: { SPLITCH_PLATFORM_TARGET: target },
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

function runDeploy(fixture, args, extraEnv = {}) {
  const env = {
    ...process.env,
  };
  for (const name of [
    "CLOUDFLARE_ENV",
    "SPLITCH_GENERATED_WRANGLER_ENV",
    "SPLITCH_PLATFORM_TARGET",
    "SPLITCH_DEPLOYED_COMMIT_SHA",
  ]) {
    delete env[name];
  }
  Object.assign(env, {
    PATH: `${fixture.binDir}:${process.env.PATH}`,
    SENTRY_RELEASE: "test-release",
    SPLITCH_DEPLOYED_COMMIT_SHA: deployedCommitSha,
    SPLITCH_FAKE_CALLS: fixture.callsPath,
    WORKOS_CLIENT_ID: "fake-workos-client-id",
  });
  Object.assign(env, extraEnv);

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

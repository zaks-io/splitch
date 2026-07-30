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

export const repoRoot = new URL("../..", import.meta.url).pathname;
const scriptPath = join(repoRoot, "scripts/deploy-vite-worker-with-sentry.mjs");
export const deployedCommitSha = "a".repeat(40);

export function createFixture({ generatedConfig, redirect = "default" }) {
  const root = mkdtempSync(join(tmpdir(), "splitch-vite-worker-deploy-test-"));
  const binDir = join(root, "bin");
  const callsPath = join(root, "calls.jsonl");

  mkdirSync(binDir, { recursive: true });
  if (generatedConfig) {
    mkdirSync(join(root, "dist/server"), { recursive: true });
    writeFileSync(join(root, "dist/server/wrangler.json"), JSON.stringify(generatedConfig));
    writeRedirect(root, redirect);
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

function writeRedirect(root, redirect) {
  const redirectDir = join(root, ".wrangler/deploy");

  if (redirect === "missing") {
    return;
  }

  mkdirSync(redirectDir, { recursive: true });

  if (redirect === "malformed") {
    writeFileSync(join(redirectDir, "config.json"), "{not json");
    return;
  }

  if (redirect === "default") {
    writeFileSync(
      join(redirectDir, "config.json"),
      JSON.stringify({ configPath: "../../dist/server/wrangler.json", auxiliaryWorkers: [] }),
    );
    return;
  }

  writeFileSync(join(redirectDir, "config.json"), JSON.stringify(redirect));
}

export function hostedGeneratedConfig({ target = "production", kvId, d1Id }) {
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

export function runDeploy(fixture, args, extraEnv = {}) {
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

export function readCalls(path) {
  if (!existsSync(path)) {
    return [];
  }

  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

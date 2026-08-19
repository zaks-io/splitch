#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const fixtureRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(fixtureRoot, "../..");
const scratchRoot = mkdtempSync(join(tmpdir(), "splitch-ssr-consumer-"));
const packRoot = join(scratchRoot, "pack");
const consumerRoot = join(scratchRoot, "consumer");

function run(command, args, options = {}) {
  execFileSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      npm_config_cache: join(scratchRoot, ".npm-cache"),
      ...options.env,
    },
  });
}

try {
  mkdirSync(packRoot);
  mkdirSync(consumerRoot);

  const packOutput = execFileSync("node", ["scripts/pack-release.mjs", packRoot], {
    cwd: join(repoRoot, "packages/sdk"),
    encoding: "utf8",
  });
  const tarballName = packOutput.trim().split("\n").at(-1);
  if (!tarballName?.endsWith(".tgz")) {
    throw new Error(`pack-release did not report a tarball path:\n${packOutput}`);
  }

  for (const file of ["browser.mjs", "package.json", "server.mjs"]) {
    cpSync(join(fixtureRoot, file), join(consumerRoot, file));
  }
  run("npm", ["install", join(packRoot, tarballName)], { cwd: consumerRoot });
  run("node", ["--test", join(fixtureRoot, "ssr-node.test.mjs")], {
    env: { SPLITCH_SSR_CONSUMER_ROOT: consumerRoot },
  });
} finally {
  rmSync(scratchRoot, { recursive: true, force: true });
}

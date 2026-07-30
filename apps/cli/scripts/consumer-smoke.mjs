#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const consumerRoot = mkdtempSync(join(tmpdir(), "splitch-cli-consumer-"));

function assertNoResolutionErrors(output) {
  if (
    /workspace:|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|Cannot find (package|module)/i.test(output)
  ) {
    throw new Error(`consumer output contains a module-resolution failure:\n${output}`);
  }
}

try {
  execFileSync("node", ["scripts/build.mjs"], {
    cwd: packageRoot,
    stdio: "inherit",
  });
  const packOutput = execFileSync("node", ["scripts/pack-release.mjs", consumerRoot], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  const tarballName = packOutput.trim().split("\n").at(-1);
  if (!tarballName?.endsWith(".tgz")) {
    throw new Error(`pack-release did not report a tarball path:\n${packOutput}`);
  }
  const tarballPath = resolve(consumerRoot, tarballName);

  writeFileSync(
    join(consumerRoot, "package.json"),
    `${JSON.stringify({ name: "splitch-cli-consumer-smoke", private: true }, null, 2)}\n`,
  );
  execFileSync("npm", ["install", tarballPath], {
    cwd: consumerRoot,
    stdio: "inherit",
    env: { ...process.env, npm_config_cache: join(consumerRoot, ".npm-cache") },
  });

  const binPath = join(consumerRoot, "node_modules/.bin/splitch");
  const result = spawnSync(binPath, [], { cwd: consumerRoot, encoding: "utf8" });
  if (result.error) throw result.error;
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  assertNoResolutionErrors(output);
  if (result.status !== 1) {
    throw new Error(`splitch with no args must exit with EXIT_USAGE (1); got ${result.status}`);
  }
  if (!output.includes("Usage:") || !output.includes("splitch login")) {
    throw new Error(`splitch with no args did not print usage:\n${output}`);
  }

  const installedManifest = readFileSync(
    join(consumerRoot, "node_modules/@splitch/cli/package.json"),
    "utf8",
  );
  assertNoResolutionErrors(installedManifest);
  console.log("consumer smoke passed");
} finally {
  rmSync(consumerRoot, { recursive: true, force: true });
}

#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { getReleaseTarget } from "./constants.mjs";

const targetKey = process.argv[2];
const target = getReleaseTarget(targetKey);
const sourceRepoRoot = process.argv[3] ?? process.cwd();
const scratchRoot = mkdtempSync(join(tmpdir(), `splitch-${targetKey}-release-clean-checkout-`));
const repoRoot = join(scratchRoot, "repo");
const outputDir = join(scratchRoot, "artifacts");

const supportPaths = {
  sdk: ["packages/contracts", "packages/sdk"],
  cli: [
    "apps/cli",
    "packages/contracts",
    "packages/control-plane-sdk",
    "packages/observability",
    "packages/privacy",
    "packages/sdk",
    "packages/worker-runtime",
  ],
};
const packagePaths = supportPaths[targetKey];
if (!packagePaths) {
  throw new Error(`no clean-checkout package set configured for ${targetKey}`);
}

mkdirSync(repoRoot, { recursive: true });
for (const path of ["tsconfig.base.json", "scripts/release", ...packagePaths]) {
  const destination = join(repoRoot, path);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(join(sourceRepoRoot, path), destination, {
    recursive: true,
    filter(source) {
      return !["coverage", "dist", "node_modules"].includes(basename(source));
    },
  });
}

for (const packagePath of ["", ...packagePaths]) {
  const sourceModules = join(sourceRepoRoot, packagePath, "node_modules");
  if (existsSync(sourceModules)) {
    const destination = join(repoRoot, packagePath, "node_modules");
    symlinkSync(sourceModules, destination, "dir");
  }
}

try {
  const output = execFileSync(
    "node",
    [
      "scripts/release/prepare-artifacts.mjs",
      targetKey,
      repoRoot,
      outputDir,
      "clean-checkout-test",
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        npm_config_cache: join(scratchRoot, "npm-cache"),
      },
    },
  );
  const manifestLine = output.trim().split("\n").at(-1);
  if (!manifestLine) {
    throw new Error("prepare-artifacts did not emit a release manifest");
  }

  const manifest = JSON.parse(manifestLine);
  if (
    manifest.packageName !== target.packageName ||
    typeof manifest.tarballName !== "string" ||
    !manifest.tarballName.endsWith(".tgz")
  ) {
    throw new Error(`prepare-artifacts did not produce the expected tarball: ${manifestLine}`);
  }

  const tarballPath = join(outputDir, manifest.tarballName);
  if (!existsSync(tarballPath)) {
    throw new Error(`missing tarball at ${tarballPath}`);
  }

  process.stdout.write("prepare clean-checkout check passed\n");
} finally {
  rmSync(scratchRoot, { recursive: true, force: true });
}

#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

const sourceRepoRoot = process.argv[2] ?? process.cwd();
const scratchRoot = mkdtempSync(join(tmpdir(), "splitch-sdk-release-clean-checkout-"));
const repoRoot = join(scratchRoot, "repo");
const outputDir = join(scratchRoot, "artifacts");

mkdirSync(repoRoot, { recursive: true });
for (const path of [
  "tsconfig.base.json",
  "scripts/sdk-release",
  "packages/contracts",
  "packages/sdk",
]) {
  const destination = join(repoRoot, path);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(join(sourceRepoRoot, path), destination, {
    recursive: true,
    filter(source) {
      return !["coverage", "dist", "node_modules"].includes(basename(source));
    },
  });
}

for (const packagePath of ["", "packages/contracts", "packages/sdk"]) {
  const sourceModules = join(sourceRepoRoot, packagePath, "node_modules");
  if (existsSync(sourceModules)) {
    const destination = join(repoRoot, packagePath, "node_modules");
    symlinkSync(sourceModules, destination, "dir");
  }
}

try {
  const output = execFileSync(
    "node",
    ["scripts/sdk-release/prepare-artifacts.mjs", repoRoot, outputDir, "clean-checkout-test"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  const manifestLine = output.trim().split("\n").at(-1);
  if (!manifestLine) {
    throw new Error("prepare-artifacts did not emit a release manifest");
  }

  const manifest = JSON.parse(manifestLine);
  if (typeof manifest.tarballName !== "string" || !manifest.tarballName.endsWith(".tgz")) {
    throw new Error(`prepare-artifacts did not produce a tarball: ${manifestLine}`);
  }

  const tarballPath = join(outputDir, manifest.tarballName);
  if (!existsSync(tarballPath)) {
    throw new Error(`missing tarball at ${tarballPath}`);
  }

  process.stdout.write("prepare clean-checkout check passed\n");
} finally {
  rmSync(scratchRoot, { recursive: true, force: true });
}

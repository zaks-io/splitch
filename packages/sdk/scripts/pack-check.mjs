#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertDryRunListing,
  assertReleaseTarballContents,
  createPackStagingDir,
  getPackageRoot,
  listTarballFiles,
  packStagingDir,
  parseTarballName,
  readTarballFile,
} from "./pack-staging.mjs";

const packageRoot = getPackageRoot();
const backupPath = join(packageRoot, "package.json.pack-backup");

execFileSync("node", ["scripts/prepack-build.mjs"], { cwd: packageRoot, stdio: "inherit" });

function assertDirectNpmPack(packageRoot) {
  const destination = mkdtempSync(join(tmpdir(), "splitch-sdk-direct-pack-"));
  try {
    const { stdout, stderr, status, error } = spawnSync(
      "npm",
      ["pack", "--pack-destination", destination],
      { cwd: packageRoot, encoding: "utf8" },
    );
    if (error) {
      throw error;
    }
    if (status !== 0) {
      throw new Error(stderr || stdout || `npm pack failed with exit code ${status}`);
    }
    const output = `${stdout}\n${stderr}`;
    const tarballName = parseTarballName(output);
    const tarballPath = join(destination, tarballName);
    const listing = listTarballFiles(tarballPath);
    const manifestText = readTarballFile(tarballPath, "package/package.json");
    const declarationText = readTarballFile(tarballPath, "package/dist/index.d.ts");
    const bundleJs = readTarballFile(tarballPath, "package/dist/index.js");
    assertReleaseTarballContents({ listing, manifestText, declarationText, bundleJs });
  } finally {
    rmSync(destination, { recursive: true, force: true });
  }
}

const workspaceManifestBefore = readFileSync(join(packageRoot, "package.json"), "utf8");
const staging = createPackStagingDir(packageRoot);

try {
  const output = packStagingDir(staging, { dryRun: true });
  assertDryRunListing(output);
} finally {
  rmSync(staging, { recursive: true, force: true });
}

assertDirectNpmPack(packageRoot);

const workspaceManifestAfter = readFileSync(join(packageRoot, "package.json"), "utf8");
if (workspaceManifestAfter !== workspaceManifestBefore) {
  throw new Error("pack:check mutated packages/sdk/package.json");
}
if (existsSync(backupPath)) {
  throw new Error("pack:check left packages/sdk/package.json.pack-backup behind");
}

console.log("pack:check passed");

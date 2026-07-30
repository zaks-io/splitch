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
const manifestPath = join(packageRoot, "package.json");
const backupPath = join(packageRoot, "package.json.pack-backup");
const workspaceManifestBefore = readFileSync(manifestPath, "utf8");

execFileSync("node", ["scripts/prepack-build.mjs"], { cwd: packageRoot, stdio: "inherit" });
execFileSync("node", ["scripts/sync-pack-manifest.mjs", "restore"], {
  cwd: packageRoot,
  stdio: "inherit",
});

function assertDirectNpmPack() {
  const destination = mkdtempSync(join(tmpdir(), "splitch-cli-direct-pack-"));
  try {
    const { stdout, stderr, status, error } = spawnSync(
      "npm",
      ["pack", "--pack-destination", destination],
      {
        cwd: packageRoot,
        encoding: "utf8",
        env: { ...process.env, npm_config_cache: join(destination, ".npm-cache") },
      },
    );
    if (error) throw error;
    if (status !== 0) {
      throw new Error(stderr || stdout || `npm pack failed with exit code ${status}`);
    }
    const tarballPath = join(destination, parseTarballName(`${stdout}\n${stderr}`));
    assertReleaseTarballContents({
      listing: listTarballFiles(tarballPath),
      manifestText: readTarballFile(tarballPath, "package/package.json"),
      cliJs: readTarballFile(tarballPath, "package/dist/cli.js"),
    });
  } finally {
    rmSync(destination, { recursive: true, force: true });
  }
}

const staging = createPackStagingDir(packageRoot);
try {
  assertDryRunListing(packStagingDir(staging, { dryRun: true }));
} finally {
  rmSync(staging, { recursive: true, force: true });
}
assertDirectNpmPack();

const workspaceManifestAfter = readFileSync(manifestPath, "utf8");
if (workspaceManifestAfter !== workspaceManifestBefore) {
  throw new Error("pack:check mutated apps/cli/package.json");
}
if (existsSync(backupPath)) {
  throw new Error("pack:check left apps/cli/package.json.pack-backup behind");
}

console.log("pack:check passed");

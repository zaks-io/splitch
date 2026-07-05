#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  assertDryRunListing,
  createPackStagingDir,
  getPackageRoot,
  packStagingDir,
} from "./pack-staging.mjs";

const packageRoot = getPackageRoot();
const backupPath = join(packageRoot, "package.json.pack-backup");

function runBuild() {
  execFileSync("node", ["scripts/sync-pack-manifest.mjs", "restore"], {
    cwd: packageRoot,
    stdio: "inherit",
  });
  execFileSync("npx", ["tsup", "--config", "tsup.contract-surface.config.ts"], {
    cwd: packageRoot,
    stdio: "inherit",
  });
  execFileSync("npx", ["tsup", "--config", "tsup.config.ts"], {
    cwd: packageRoot,
    stdio: "inherit",
  });
}

runBuild();

const workspaceManifestBefore = readFileSync(join(packageRoot, "package.json"), "utf8");
const staging = createPackStagingDir(packageRoot);

try {
  const output = packStagingDir(staging, { dryRun: true });
  assertDryRunListing(output);
} finally {
  rmSync(staging, { recursive: true, force: true });
}

const workspaceManifestAfter = readFileSync(join(packageRoot, "package.json"), "utf8");
if (workspaceManifestAfter !== workspaceManifestBefore) {
  throw new Error("pack:check mutated packages/sdk/package.json");
}
if (existsSync(backupPath)) {
  throw new Error("pack:check left packages/sdk/package.json.pack-backup behind");
}

console.log("pack:check passed");

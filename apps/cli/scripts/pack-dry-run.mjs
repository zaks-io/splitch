#!/usr/bin/env node
import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyBuildStamp } from "../../../scripts/release/build-stamp.mjs";
import {
  assertDryRunListing,
  createPackStagingDir,
  getPackageRoot,
  packStagingDir,
} from "./pack-staging.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
verifyBuildStamp("cli", repoRoot);

const staging = createPackStagingDir(getPackageRoot());
try {
  assertDryRunListing(packStagingDir(staging, { dryRun: true }));
} finally {
  rmSync(staging, { recursive: true, force: true });
}

console.log("pack:dry-run passed");

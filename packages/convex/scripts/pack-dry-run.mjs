#!/usr/bin/env node
import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyBuildStamp } from "../../../scripts/release/build-stamp.mjs";
import { createStagingDirectory, pack } from "./pack-staging.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
verifyBuildStamp("convex", repoRoot);
const staging = createStagingDirectory();
try {
  const listing = pack(staging, undefined, true);
  for (const required of [
    "dist/index.js",
    "dist/index.d.ts",
    "dist/react/index.js",
    "dist/react/index.d.ts",
    "dist/component/convex.config.js",
    "dist/component/integration_recovery.js",
    "dist/component/integration_recovery.d.ts",
  ]) {
    if (!listing.includes(required)) throw new Error(`pack --dry-run is missing ${required}`);
  }
  if (listing.includes("dist/component/crons.")) {
    throw new Error("pack --dry-run contains the removed cron module");
  }
} finally {
  rmSync(staging, { recursive: true, force: true });
}
console.log("pack:dry-run passed");

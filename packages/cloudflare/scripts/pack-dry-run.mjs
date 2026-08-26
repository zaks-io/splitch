#!/usr/bin/env node
import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyBuildStamp } from "../../../scripts/release/build-stamp.mjs";
import { createStagingDirectory, pack } from "./pack-staging.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
verifyBuildStamp("cloudflare", repoRoot);
const staging = createStagingDirectory();
try {
  const listing = pack(staging, undefined, true);
  for (const required of [
    "dist/index.js",
    "dist/index.d.ts",
    "dist/worker.js",
    "dist/worker.d.ts",
  ]) {
    if (!listing.includes(required)) throw new Error(`pack --dry-run is missing ${required}`);
  }
} finally {
  rmSync(staging, { recursive: true, force: true });
}
console.log("pack:dry-run passed");

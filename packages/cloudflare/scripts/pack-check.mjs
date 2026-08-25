#!/usr/bin/env node
import { readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeSourceDigest,
  computeTreeDigest,
  verifyBuildStamp,
} from "../../../scripts/release/build-stamp.mjs";
import { assertPublishKeepsManifest } from "../../../scripts/release/publish-manifest-probe.mjs";
import {
  assertPackedTarball,
  createStagingDirectory,
  pack,
  packageRoot,
  tarballName,
} from "./pack-staging.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
verifyBuildStamp("cloudflare", repoRoot);
const sourceBefore = computeSourceDigest("cloudflare", repoRoot);
const distBefore = computeTreeDigest(join(packageRoot, "dist"));
const manifestBefore = readFileSync(join(packageRoot, "package.json"), "utf8");
const staging = createStagingDirectory();
try {
  assertPublishKeepsManifest(staging);
  const name = tarballName(pack(staging, staging));
  assertPackedTarball(join(staging, name));
} finally {
  rmSync(staging, { recursive: true, force: true });
}
if (computeSourceDigest("cloudflare", repoRoot) !== sourceBefore)
  throw new Error("pack:check mutated build inputs");
if (computeTreeDigest(join(packageRoot, "dist")) !== distBefore)
  throw new Error("pack:check mutated dist");
if (readFileSync(join(packageRoot, "package.json"), "utf8") !== manifestBefore)
  throw new Error("pack:check mutated package.json");
console.log("@splitch/cloudflare pack check passed");

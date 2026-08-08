#!/usr/bin/env node
import { execFileSync } from "node:child_process";
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
  assertReleaseTarballContents,
  createPackStagingDir,
  getPackageRoot,
  listTarballFiles,
  packStagingDir,
  parseTarballName,
  readTarballFile,
} from "./pack-staging.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const packageRoot = getPackageRoot();

verifyBuildStamp("sdk", repoRoot);
const digestBefore = computeSourceDigest("sdk", repoRoot);
const distDigestBefore = computeTreeDigest(join(packageRoot, "dist"));
const manifestBefore = readFileSync(join(packageRoot, "package.json"), "utf8");

const staging = createPackStagingDir(packageRoot);
try {
  assertPublishKeepsManifest(staging);
  const output = packStagingDir(staging, { destination: staging });
  const tarballPath = join(staging, parseTarballName(output));
  assertReleaseTarballContents({
    listing: listTarballFiles(tarballPath),
    manifestText: readTarballFile(tarballPath, "package/package.json"),
    declarationText: readTarballFile(tarballPath, "package/dist/index.d.ts"),
    bundleJs: readTarballFile(tarballPath, "package/dist/index.js"),
  });
} finally {
  rmSync(staging, { recursive: true, force: true });
}

// Per-entry browser budget (SPL-325). Runs after the tarball assertions so a
// zero-dep pack failure stays the louder signal when both fail.
execFileSync(process.execPath, [join(packageRoot, "scripts/size-check.mjs")], {
  cwd: packageRoot,
  stdio: "inherit",
});

// The no-mutation contract: packing must leave the live tree untouched.
if (computeSourceDigest("sdk", repoRoot) !== digestBefore) {
  throw new Error("pack:check mutated packages/sdk build inputs");
}
if (computeTreeDigest(join(packageRoot, "dist")) !== distDigestBefore) {
  throw new Error("pack:check mutated packages/sdk/dist");
}
if (readFileSync(join(packageRoot, "package.json"), "utf8") !== manifestBefore) {
  throw new Error("pack:check mutated packages/sdk/package.json");
}

console.log("pack:check passed");

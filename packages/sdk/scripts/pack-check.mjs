#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeSourceDigest,
  computeTreeDigest,
  verifyBuildStamp,
} from "../../../scripts/release/build-stamp.mjs";
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

// npm publish runs a manifest fixer that npm pack does not; it can silently
// drop fields it dislikes. Fail loud if the publish path would ship anything
// other than the checked manifest.
function assertPublishKeepsManifest(stagingDir) {
  const { stdout, stderr, status, error } = spawnSync("npm", ["publish", "--dry-run"], {
    cwd: stagingDir,
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: join(stagingDir, ".npm-cache") },
  });
  if (error) throw error;
  if (status !== 0) {
    throw new Error(stderr || stdout || `npm publish --dry-run failed with exit code ${status}`);
  }
  const output = `${stdout}\n${stderr}`;
  if (/auto-corrected|errors corrected|was invalid/i.test(output)) {
    throw new Error(`npm publish would rewrite the release manifest:\n${output}`);
  }
}

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

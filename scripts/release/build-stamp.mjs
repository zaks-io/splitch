import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { getReleaseTarget } from "./constants.mjs";

const STAMP_FILENAME = "build-stamp.json";

function collectFiles(root, entryPath, files) {
  const stats = statSync(entryPath);
  if (stats.isFile()) {
    files.push(entryPath);
    return;
  }
  for (const name of readdirSync(entryPath).sort()) {
    collectFiles(root, join(entryPath, name), files);
  }
}

/**
 * Deterministic digest over the target's declared build inputs: sorted
 * relative paths plus file contents. Two trees with identical inputs always
 * produce identical digests, so stamps (and staged tarballs) are reproducible.
 */
export function computeSourceDigest(targetKey, repoRoot) {
  const target = getReleaseTarget(targetKey);
  const packageRoot = join(repoRoot, target.packageDir);
  const hash = createHash("sha256");
  const files = [];
  for (const input of target.stampInputs) {
    const inputPath = join(packageRoot, input);
    if (!existsSync(inputPath)) {
      continue;
    }
    collectFiles(packageRoot, inputPath, files);
  }
  files.sort();
  for (const filePath of files) {
    const relativePath = relative(packageRoot, filePath).split(sep).join("/");
    if (relativePath === `dist/${STAMP_FILENAME}`) {
      continue;
    }
    hash.update(relativePath);
    hash.update("\0");
    hash.update(readFileSync(filePath));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** Digest of an arbitrary directory tree; used to prove a tree was not mutated. */
export function computeTreeDigest(dir) {
  const hash = createHash("sha256");
  if (existsSync(dir)) {
    const files = [];
    collectFiles(dir, dir, files);
    files.sort();
    for (const filePath of files) {
      hash.update(relative(dir, filePath).split(sep).join("/"));
      hash.update("\0");
      hash.update(readFileSync(filePath));
      hash.update("\0");
    }
  }
  return hash.digest("hex");
}

function stampPath(targetKey, repoRoot) {
  const target = getReleaseTarget(targetKey);
  return join(repoRoot, target.packageDir, "dist", STAMP_FILENAME);
}

/** Called by each package's build as its final step; the only stamp writer. */
export function writeBuildStamp(targetKey, repoRoot) {
  const target = getReleaseTarget(targetKey);
  const manifest = JSON.parse(readFileSync(join(repoRoot, target.packagePath), "utf8"));
  const stamp = {
    packageName: target.packageName,
    version: manifest.version,
    sourceDigest: computeSourceDigest(targetKey, repoRoot),
  };
  writeFileSync(stampPath(targetKey, repoRoot), `${JSON.stringify(stamp, null, 2)}\n`);
  return stamp;
}

/**
 * Fail-loud freshness check: dist must exist and its stamp must match the
 * current source. Nothing in the pack or publish path may rebuild; a stale
 * tree is an error with one remediation, never a silent rebuild.
 */
export function verifyBuildStamp(targetKey, repoRoot) {
  const target = getReleaseTarget(targetKey);
  const remediation = `run \`pnpm --filter ${target.packageName} build\` and retry`;
  const path = stampPath(targetKey, repoRoot);
  if (!existsSync(path)) {
    throw new Error(
      `${target.packageDir}/dist/${STAMP_FILENAME} is missing; dist was not produced by the package build. Remediation: ${remediation}`,
    );
  }
  const stamp = JSON.parse(readFileSync(path, "utf8"));
  const manifest = JSON.parse(readFileSync(join(repoRoot, target.packagePath), "utf8"));
  if (stamp.packageName !== target.packageName || stamp.version !== manifest.version) {
    throw new Error(
      `${target.packageDir} build stamp is for ${stamp.packageName}@${stamp.version} but the manifest is ${target.packageName}@${manifest.version}. Remediation: ${remediation}`,
    );
  }
  const digest = computeSourceDigest(targetKey, repoRoot);
  if (stamp.sourceDigest !== digest) {
    throw new Error(
      `${target.packageDir}/dist is stale: build stamp digest ${stamp.sourceDigest} does not match current sources (${digest}). Remediation: ${remediation}`,
    );
  }
  return stamp;
}

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { getReleaseTarget } from "./constants.mjs";

const STAMP_FILENAME = "build-stamp.json";

/**
 * Resolves segments against a base directory and fails loud if the result
 * escapes it, so no declared input or argument can reach outside the repo.
 */
export function containedPath(baseDir, ...segments) {
  const base = resolve(baseDir);
  const resolved = resolve(base, ...segments);
  if (resolved !== base && !resolved.startsWith(base + sep)) {
    throw new Error(`path ${resolved} escapes ${base}`);
  }
  return resolved;
}

function collectFiles(root, entryPath, files) {
  const stats = statSync(entryPath);
  if (stats.isFile()) {
    files.push(entryPath);
    return;
  }
  for (const name of readdirSync(entryPath).sort()) {
    collectFiles(root, containedPath(entryPath, name), files);
  }
}

/**
 * Deterministic digest over the target's declared build inputs: sorted
 * relative paths plus file contents. Two trees with identical inputs always
 * produce identical digests, so stamps (and staged tarballs) are reproducible.
 */
export function computeSourceDigest(targetKey, repoRoot) {
  const target = getReleaseTarget(targetKey);
  const packageRoot = containedPath(repoRoot, target.packageDir);
  const hash = createHash("sha256");
  const files = [];
  for (const input of target.stampInputs) {
    const inputPath = containedPath(repoRoot, target.packageDir, input);
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
  return containedPath(repoRoot, target.packageDir, "dist", STAMP_FILENAME);
}

/** Digest of dist itself, excluding the stamp file the digest is stored in. */
function computeDistDigest(targetKey, repoRoot) {
  const target = getReleaseTarget(targetKey);
  const distDir = containedPath(repoRoot, target.packageDir, "dist");
  const hash = createHash("sha256");
  const files = [];
  if (existsSync(distDir)) {
    collectFiles(distDir, distDir, files);
  }
  files.sort();
  for (const filePath of files) {
    const relativePath = relative(distDir, filePath).split(sep).join("/");
    if (relativePath === STAMP_FILENAME) {
      continue;
    }
    hash.update(relativePath);
    hash.update("\0");
    hash.update(readFileSync(filePath));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** Called by each package's build as its final step; the only stamp writer. */
export function writeBuildStamp(targetKey, repoRoot) {
  const target = getReleaseTarget(targetKey);
  const manifest = JSON.parse(readFileSync(containedPath(repoRoot, target.packagePath), "utf8"));
  const stamp = {
    packageName: target.packageName,
    version: manifest.version,
    sourceDigest: computeSourceDigest(targetKey, repoRoot),
    distDigest: computeDistDigest(targetKey, repoRoot),
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
  const manifest = JSON.parse(readFileSync(containedPath(repoRoot, target.packagePath), "utf8"));
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
  const distDigest = computeDistDigest(targetKey, repoRoot);
  if (stamp.distDigest !== distDigest) {
    throw new Error(
      `${target.packageDir}/dist was modified after the build: stamped dist digest ${stamp.distDigest} does not match current dist (${distDigest}). Remediation: ${remediation}`,
    );
  }
  return stamp;
}

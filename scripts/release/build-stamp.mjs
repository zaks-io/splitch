import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
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
 * Turbo folds `globalEnv` (CI, NODE_ENV) into the task hash. Vitest sets
 * NODE_ENV=test and CI runners set CI=true, which would make a stamp written
 * during `pnpm build` look stale under `vitest`/`pack:check` with no source
 * change. Strip those for stamp digests only — file inputs and dependency
 * task hashes still move the digest.
 */
function turboStampEnv() {
  const env = { ...process.env };
  delete env.CI;
  delete env.NODE_ENV;
  return env;
}

function readTurboBuildDryRun(packageName, repoRoot) {
  const turboBin = containedPath(repoRoot, "node_modules", ".bin", "turbo");
  if (!existsSync(turboBin)) {
    throw new Error(
      `turbo binary missing at ${turboBin}; install workspace deps before stamping ${packageName}`,
    );
  }
  let out;
  try {
    // Pipe stderr so turbo's startup banner does not leak into every stamp
    // caller's logs (build, pack:check, vitest).
    out = execFileSync(turboBin, ["run", "build", `--filter=${packageName}`, "--dry=json"], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: turboStampEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`turbo dry-run failed for ${packageName}: ${detail}`);
  }
  const start = out.indexOf("{");
  if (start === -1) {
    throw new Error(`turbo dry-run produced no JSON for ${packageName}`);
  }
  return JSON.parse(out.slice(start));
}

/**
 * Extract the build task hash from a turbo `--dry=json` payload. Exported so
 * the shape guard (missing/empty hash → throw) is unit-testable without a
 * live turbo binary; production always goes through computeSourceDigest.
 */
export function buildTaskHashFromDryRun(dry, packageName) {
  const task = (dry.tasks ?? []).find(
    (entry) => entry.package === packageName && entry.task === "build",
  );
  if (task === undefined || typeof task.hash !== "string" || task.hash.length === 0) {
    throw new Error(`turbo dry-run missing build task hash for ${packageName}`);
  }
  return task.hash;
}

/**
 * Source digest = Turbo's build task hash for the release target. Requires a
 * real workspace `turbo.json` — there is no silent file-hash fallback (a missing
 * turbo.json used to change the digest algorithm without failing the stamp).
 * Hermetic fixtures pass `options.sourceDigest` to write/verify instead.
 */
export function computeSourceDigest(targetKey, repoRoot) {
  const turboJson = containedPath(repoRoot, "turbo.json");
  if (!existsSync(turboJson)) {
    throw new Error(
      `turbo.json missing at ${turboJson}; cannot derive a Turbo build-stamp source digest for ${targetKey}. Remediation: run from the repo root (or pass sourceDigest explicitly in hermetic fixtures)`,
    );
  }
  const target = getReleaseTarget(targetKey);
  const dry = readTurboBuildDryRun(target.packageName, repoRoot);
  return buildTaskHashFromDryRun(dry, target.packageName);
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

/**
 * Called by each package's build as its final step; the only stamp writer.
 * `options.sourceDigest` is for hermetic tests that need to plant a known
 * (or deliberately stale) digest; production writers never pass it.
 */
export function writeBuildStamp(targetKey, repoRoot, options = {}) {
  const target = getReleaseTarget(targetKey);
  const manifest = JSON.parse(readFileSync(containedPath(repoRoot, target.packagePath), "utf8"));
  const stamp = {
    packageName: target.packageName,
    version: manifest.version,
    sourceDigest: options.sourceDigest ?? computeSourceDigest(targetKey, repoRoot),
    distDigest: computeDistDigest(targetKey, repoRoot),
  };
  writeFileSync(stampPath(targetKey, repoRoot), `${JSON.stringify(stamp, null, 2)}\n`);
  return stamp;
}

/**
 * Fail-loud freshness check: dist must exist and its stamp must match the
 * current source. Nothing in the pack or publish path may rebuild; a stale
 * tree is an error with one remediation, never a silent rebuild.
 *
 * `options.sourceDigest` is for hermetic fixtures only (scratch trees without
 * turbo.json); production pack/publish never passes it.
 */
export function verifyBuildStamp(targetKey, repoRoot, options = {}) {
  const target = getReleaseTarget(targetKey);
  const remediation = `run \`pnpm --filter ${target.packageName} build\` and retry`;
  const path = stampPath(targetKey, repoRoot);
  if (!existsSync(path)) {
    throw new Error(
      `${target.packageDir}/dist/${STAMP_FILENAME} is missing; dist was not produced by the package build. Remediation: ${remediation}`,
    );
  }
  const stamp = JSON.parse(readFileSync(path, "utf8"));
  if (typeof stamp.sourceDigest !== "string" || stamp.sourceDigest.length === 0) {
    throw new Error(
      `${target.packageDir}/dist/${STAMP_FILENAME} is degraded: sourceDigest must be a non-empty string. Remediation: ${remediation}`,
    );
  }
  const manifest = JSON.parse(readFileSync(containedPath(repoRoot, target.packagePath), "utf8"));
  if (stamp.packageName !== target.packageName || stamp.version !== manifest.version) {
    throw new Error(
      `${target.packageDir} build stamp is for ${stamp.packageName}@${stamp.version} but the manifest is ${target.packageName}@${manifest.version}. Remediation: ${remediation}`,
    );
  }
  const digest = options.sourceDigest ?? computeSourceDigest(targetKey, repoRoot);
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

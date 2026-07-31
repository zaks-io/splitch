#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getReleaseTarget } from "./constants.mjs";

export function readReleaseManifest(targetKey, repoRoot) {
  const config = getReleaseTarget(targetKey);
  return JSON.parse(readFileSync(join(repoRoot, config.packagePath), "utf8"));
}

const RELEASE_SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)*$/;

export function readReleaseVersion(targetKey, repoRoot) {
  const config = getReleaseTarget(targetKey);
  const manifest = readReleaseManifest(targetKey, repoRoot);
  if (typeof manifest.version !== "string" || manifest.version.trim().length === 0) {
    throw new Error(`${config.packagePath} is missing a release version`);
  }
  const version = manifest.version.trim();
  if (!RELEASE_SEMVER_PATTERN.test(version)) {
    throw new Error(
      `${config.packagePath} version ${JSON.stringify(version)} is not a release semver`,
    );
  }
  return version;
}

export function deriveReleaseTag(targetKey, version) {
  return `${getReleaseTarget(targetKey).tagPrefix}${version}`;
}

export function resolveReleaseTarget(targetKey, repoRoot) {
  const config = getReleaseTarget(targetKey);
  const version = readReleaseVersion(targetKey, repoRoot);
  return {
    version,
    tag: deriveReleaseTag(targetKey, version),
    packageName: config.packageName,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const targetKey = process.argv[2];
  const repoRoot = process.argv[3] ?? process.cwd();
  process.stdout.write(`${JSON.stringify(resolveReleaseTarget(targetKey, repoRoot))}\n`);
}

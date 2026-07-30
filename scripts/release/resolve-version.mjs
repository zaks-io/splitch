#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getReleaseTarget } from "./constants.mjs";

export function readReleaseManifest(targetKey, repoRoot) {
  const config = getReleaseTarget(targetKey);
  return JSON.parse(readFileSync(join(repoRoot, config.packagePath), "utf8"));
}

export function readReleaseVersion(targetKey, repoRoot) {
  const config = getReleaseTarget(targetKey);
  const manifest = readReleaseManifest(targetKey, repoRoot);
  if (typeof manifest.version !== "string" || manifest.version.trim().length === 0) {
    throw new Error(`${config.packagePath} is missing a release version`);
  }
  return manifest.version.trim();
}

export function deriveReleaseTag(targetKey, version) {
  return `${getReleaseTarget(targetKey).tagPrefix}${version}`;
}

export function assertAllowedReleaseVersion(targetKey, version) {
  const config = getReleaseTarget(targetKey);
  if (version !== config.allowedVersion) {
    throw new Error(
      `${targetKey.toUpperCase()} release workflow currently allows only version ${config.allowedVersion}; found ${version}`,
    );
  }
}

export function resolveReleaseTarget(targetKey, repoRoot) {
  const config = getReleaseTarget(targetKey);
  const version = readReleaseVersion(targetKey, repoRoot);
  assertAllowedReleaseVersion(targetKey, version);
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

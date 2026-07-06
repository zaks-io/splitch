#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FIRST_RELEASE_VERSION, SDK_PACKAGE_PATH, SDK_TAG_PREFIX } from "./constants.mjs";

/**
 * @param {string} repoRoot
 */
export function readSdkManifest(repoRoot) {
  return JSON.parse(readFileSync(join(repoRoot, SDK_PACKAGE_PATH), "utf8"));
}

/**
 * @param {string} repoRoot
 */
export function readSdkVersion(repoRoot) {
  const manifest = readSdkManifest(repoRoot);
  if (typeof manifest.version !== "string" || manifest.version.trim().length === 0) {
    throw new Error(`${SDK_PACKAGE_PATH} is missing a release version`);
  }
  return manifest.version.trim();
}

/**
 * @param {string} version
 */
export function deriveSdkTag(version) {
  return `${SDK_TAG_PREFIX}${version}`;
}

/**
 * @param {string} version
 */
export function assertFirstReleaseVersion(version) {
  if (version !== FIRST_RELEASE_VERSION) {
    throw new Error(
      `SDK release workflow currently allows only version ${FIRST_RELEASE_VERSION}; found ${version}`,
    );
  }
}

/**
 * @param {string} repoRoot
 */
export function resolveSdkReleaseTarget(repoRoot) {
  const version = readSdkVersion(repoRoot);
  assertFirstReleaseVersion(version);
  return {
    version,
    tag: deriveSdkTag(version),
    packageName: "@splitch/sdk",
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const repoRoot = process.argv[2] ?? process.cwd();
  const target = resolveSdkReleaseTarget(repoRoot);
  process.stdout.write(`${JSON.stringify(target)}\n`);
}

#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getReleaseTarget } from "./constants.mjs";

const NPM_REGISTRY = "https://registry.npmjs.org";

/**
 * @typedef {{ status: number | null; stdout: string; stderr: string }} NpmViewResult
 */

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{ encoding: "utf8" }} options
 * @returns {NpmViewResult}
 */
function runNpmView(command, args, options) {
  const result = spawnSync(command, args, options);
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/**
 * @param {NpmViewResult} result
 * @param {string} packageName
 * @param {string} version
 */
function interpretNpmView(result, packageName, version) {
  if (result.status === 0) {
    let publishedVersion;
    try {
      publishedVersion = JSON.parse(result.stdout.trim());
    } catch (error) {
      throw new Error(
        `npm view returned invalid JSON: ${error instanceof Error ? error.message : error}`,
      );
    }
    if (publishedVersion !== version) {
      throw new Error(
        `npm returned ${publishedVersion} for ${packageName}@${version}; refusing an ambiguous result`,
      );
    }
    return true;
  }

  if (result.stderr.includes("E404")) {
    return false;
  }

  throw new Error(
    `npm view failed for ${packageName}@${version} without a not-found response:\n${result.stderr.trim()}`,
  );
}

/**
 * @param {{
 *   targetKey?: string;
 *   version?: string;
 *   run?: (command: string, args: string[], options: { encoding: "utf8" }) => NpmViewResult;
 * }} [options]
 */
export function checkPublishedVersion({
  targetKey = process.argv[2],
  version = process.argv[3]?.trim(),
  run = runNpmView,
} = {}) {
  const target = getReleaseTarget(targetKey);
  if (!version) {
    throw new Error(
      `${targetKey.toUpperCase()}_VERSION is required to check npm publication state`,
    );
  }

  const result = run(
    "npm",
    ["view", `${target.packageName}@${version}`, "version", "--json", `--registry=${NPM_REGISTRY}`],
    { encoding: "utf8" },
  );
  return interpretNpmView(result, target.packageName, version);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${checkPublishedVersion()}\n`);
}

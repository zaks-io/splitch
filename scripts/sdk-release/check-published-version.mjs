#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SDK_PACKAGE = "@splitch/sdk";
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
 * @param {string} version
 */
function interpretNpmView(result, version) {
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
        `npm returned ${publishedVersion} for ${SDK_PACKAGE}@${version}; refusing an ambiguous result`,
      );
    }
    return true;
  }

  if (result.stderr.includes("E404")) {
    return false;
  }

  throw new Error(
    `npm view failed for ${SDK_PACKAGE}@${version} without a not-found response:\n${result.stderr.trim()}`,
  );
}

/**
 * @param {{
 *   version?: string;
 *   run?: (command: string, args: string[], options: { encoding: "utf8" }) => NpmViewResult;
 * }} [options]
 */
export function checkPublishedVersion({
  version = process.argv[2]?.trim(),
  run = runNpmView,
} = {}) {
  if (!version) {
    throw new Error("SDK_VERSION is required to check npm publication state");
  }

  const result = run(
    "npm",
    ["view", `${SDK_PACKAGE}@${version}`, "version", "--json", `--registry=${NPM_REGISTRY}`],
    { encoding: "utf8" },
  );
  return interpretNpmView(result, version);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${checkPublishedVersion()}\n`);
}

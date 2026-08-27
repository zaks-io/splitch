import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { scriptHasUnpinnedInstall } from "./privileged-toolchain-install.mjs";

const ACTION_FILENAMES = new Set(["action.yml", "action.yaml"]);

/**
 * Recursively load composite action files under `actions/`.
 *
 * @param {string} githubRoot
 * @returns {{ name: string, source: string, kind: "action", githubRoot: string }[]}
 */
export function loadActionFiles(githubRoot) {
  return walkActionFiles(join(githubRoot, "actions")).map((file) => ({ ...file, githubRoot }));
}

/**
 * Walk a privileged job or composite action and honor caller `with:` overrides.
 *
 * @param {object} document
 * @param {object} job
 * @param {object[]} steps
 * @param {string} githubRoot
 * @param {Record<string, string>} [inputOverrides]
 * @param {Set<string>} [seen]
 * @returns {boolean}
 */
export function stepsHaveUnpinnedInstall(
  document,
  job,
  steps,
  githubRoot,
  inputOverrides = {},
  seen = new Set(),
) {
  return steps.some((step) =>
    stepHasUnpinnedInstall(document, job, step, githubRoot, inputOverrides, seen),
  );
}

/**
 * @param {unknown} document
 * @returns {boolean}
 */
export function isCompositeAction(document) {
  return (
    isPlainObject(document) && isPlainObject(document.runs) && document.runs.using === "composite"
  );
}

/**
 * @param {unknown} document
 * @returns {object[]}
 */
export function compositeSteps(document) {
  return isPlainObject(document) &&
    isPlainObject(document.runs) &&
    Array.isArray(document.runs.steps)
    ? document.runs.steps
    : [];
}

/**
 * @param {unknown} document
 * @returns {Record<string, string>}
 */
function actionInputDefaults(document) {
  if (!isPlainObject(document) || !isPlainObject(document.inputs)) return {};
  const defaults = {};
  for (const [name, spec] of Object.entries(document.inputs)) {
    if (!isPlainObject(spec) || spec.default === undefined || spec.default === null) continue;
    defaults[name] = String(spec.default);
  }
  return defaults;
}

/**
 * @param {unknown} value
 * @returns {Record<string, string>}
 */
function stringMap(value) {
  if (!isPlainObject(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => typeof item === "string" || typeof item === "number")
      .map(([key, item]) => [key, String(item)]),
  );
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function walkActionFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory()) return [];
    const nested = join(directory, entry.name);
    return [...actionFilesInDirectory(nested), ...walkActionFiles(nested)];
  });
}

function actionFilesInDirectory(directory) {
  return [...ACTION_FILENAMES]
    .map((filename) => join(directory, filename))
    .filter(existsSync)
    .map((path) => ({
      name: path,
      source: readFileSync(path, "utf8"),
      kind: /** @type {const} */ ("action"),
    }));
}

function stepHasUnpinnedInstall(document, job, step, githubRoot, inputOverrides, seen) {
  if (typeof step?.run === "string") {
    return scriptHasUnpinnedInstall(step.run, {
      inputs: { ...actionInputDefaults(document), ...inputOverrides },
      env: {
        ...stringMap(document.env),
        ...stringMap(job?.env),
        ...stringMap(step.env),
      },
    });
  }
  if (typeof step?.uses !== "string" || !isLocalUses(step.uses)) return false;
  return localActionHasUnpinnedInstall(step, githubRoot, seen);
}

function localActionHasUnpinnedInstall(step, githubRoot, seen) {
  const path = resolveLocalActionPath(step.uses, githubRoot);
  if (path === null) return true;
  if (seen.has(path)) return false;
  seen.add(path);
  const document = parse(readFileSync(path, "utf8"));
  if (!isCompositeAction(document)) return false;
  const inputs = { ...actionInputDefaults(document), ...stringMap(step.with) };
  return stepsHaveUnpinnedInstall(document, {}, compositeSteps(document), githubRoot, inputs, seen);
}

function isLocalUses(ref) {
  return ref.startsWith("./") || ref.startsWith(".github/");
}

function resolveLocalActionPath(ref, githubRoot) {
  return (
    localActionDirectories(ref, githubRoot)
      .map((directory) => actionDescriptorPath(directory))
      .find((path) => path !== null) ?? null
  );
}

function localActionDirectories(ref, githubRoot) {
  const relative = ref.replace(/^\.\//, "");
  const directories = [join(githubRoot, relative), join(githubRoot, "..", relative)];
  if (relative.startsWith(".github/")) {
    directories.push(join(githubRoot, relative.slice(".github/".length)));
  }
  return directories;
}

function actionDescriptorPath(directory) {
  return (
    [...ACTION_FILENAMES].map((filename) => join(directory, filename)).find(existsSync) ?? null
  );
}

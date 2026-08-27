import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const ACTION_FILENAMES = new Set(["action.yml", "action.yaml"]);
const WORKFLOW_EXTENSIONS = new Set([".yml", ".yaml"]);
const FLOATING_PACKAGE =
  /(?:npm|pnpm|yarn|npx|pip|uv|cargo)\s+(?:install|add|exec)\s[^\n]*@[\^~*]|npm@[\^~]|npm@(?:latest|next)\b/;
export const MUTABLE_INSTALLER = /curl[^\n]*\|\s*(?:ba)?sh\b/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const ACTION_USES = /uses:\s+(\S+)/g;

/**
 * Load composite actions and workflows GitHub executes (`.yml` and `.yaml`).
 *
 * @param {string} [githubRoot=".github"]
 * @returns {{ name: string, source: string, kind: "action" | "workflow" }[]}
 */
export function loadGithubCiFiles(githubRoot = ".github") {
  return [...loadActionFiles(githubRoot), ...loadWorkflowFiles(githubRoot)];
}

/**
 * Collect every resolved `run` string from a GitHub Actions YAML document.
 *
 * @param {string} source
 * @returns {string[]}
 */
export function extractRunScripts(source) {
  return collectStringRuns(parseGithubYaml(source));
}

/**
 * Remove shell backslash-newline continuations so `curl … \` / `| sh`
 * becomes one pipeline before installer detection.
 *
 * @param {string} script
 * @returns {string}
 */
export function normalizeShellContinuations(script) {
  return script.replace(/\\[ \t]*\r?\n/g, "");
}

/**
 * @param {string} script
 * @returns {boolean}
 */
export function scriptHasMutableInstaller(script) {
  return MUTABLE_INSTALLER.test(normalizeShellContinuations(script));
}

/**
 * @param {{ name: string, source: string, kind: "action" | "workflow" }[]} files
 * @returns {string[]}
 */
export function mutableInstallerViolations(files) {
  return files.flatMap(mutableInstallerViolationsForFile);
}

/**
 * @param {{ name: string, source: string }[]} files
 * @returns {string[]}
 */
export function floatingPackageViolations(files) {
  return files.flatMap(floatingPackageViolationsForFile);
}

/**
 * @param {{ name: string, source: string }[]} files
 * @returns {string[]}
 */
export function unpinnedActionViolations(files) {
  return files.flatMap(({ name, source }) =>
    [...source.matchAll(ACTION_USES)].flatMap((match) => actionPinViolations(name, source, match)),
  );
}

function loadActionFiles(githubRoot) {
  const actionsDir = join(githubRoot, "actions");
  if (!existsSync(actionsDir)) return [];
  return readdirSync(actionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => actionFilesInDirectory(join(actionsDir, entry.name)));
}

function actionFilesInDirectory(directory) {
  return [...ACTION_FILENAMES]
    .map((filename) => join(directory, filename))
    .filter(existsSync)
    .map((path) => readCiFile(path, "action"));
}

function loadWorkflowFiles(githubRoot) {
  const workflowsDir = join(githubRoot, "workflows");
  if (!existsSync(workflowsDir)) return [];
  return readdirSync(workflowsDir)
    .filter((filename) => WORKFLOW_EXTENSIONS.has(extensionOf(filename)))
    .map((filename) => readCiFile(join(workflowsDir, filename), "workflow"));
}

function readCiFile(path, kind) {
  return { name: path, source: readFileSync(path, "utf8"), kind };
}

function extensionOf(filename) {
  return filename.slice(filename.lastIndexOf("."));
}

function parseGithubYaml(source) {
  const document = parse(source);
  if (!isPlainObject(document)) {
    throw new Error("GitHub Actions YAML must parse to a mapping");
  }
  return document;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function collectStringRuns(value, scripts = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectStringRuns(item, scripts);
    return scripts;
  }
  if (!isPlainObject(value)) return scripts;
  if (typeof value.run === "string") scripts.push(value.run);
  for (const child of Object.values(value)) collectStringRuns(child, scripts);
  return scripts;
}

function parsedJobs(document) {
  if (!isPlainObject(document.jobs)) return [];
  return Object.entries(document.jobs).map(([name, job]) => ({ name, job }));
}

function hasIdTokenWrite(permissions) {
  if (permissions === "write-all") return true;
  return isPlainObject(permissions) && permissions["id-token"] === "write";
}

function environmentName(environment) {
  if (typeof environment === "string") return environment;
  return isPlainObject(environment) && typeof environment.name === "string" ? environment.name : "";
}

function jobIsOidc(document, job) {
  return hasIdTokenWrite(document.permissions) || hasIdTokenWrite(job?.permissions);
}

function jobIsPrivileged(document, job) {
  const name = environmentName(job?.environment);
  return jobIsOidc(document, job) || name === "production" || name === "shared-preview";
}

function isPrivilegedFile(file, document) {
  return (
    file.kind === "action" || parsedJobs(document).some(({ job }) => jobIsPrivileged(document, job))
  );
}

function mutableInstallerViolationsForFile(file) {
  const document = parseGithubYaml(file.source);
  if (!isPrivilegedFile(file, document)) return [];
  const violations = collectStringRuns(document)
    .filter(scriptHasMutableInstaller)
    .map(() => `${file.name} pipes a remote installer to a shell`);
  if (/astral\.sh\/uv\/install/.test(file.source)) {
    violations.push(`${file.name} uses the mutable uv installer`);
  }
  return violations;
}

function floatingPackageViolationsForFile(file) {
  const document = parseGithubYaml(file.source);
  return parsedJobs(document)
    .map(({ name, job }) => floatingPackageViolationForJob(file, document, name, job))
    .filter((violation) => violation !== null);
}

function floatingPackageViolationForJob(file, document, name, job) {
  if (!jobIsOidc(document, job)) return null;
  const hasFloating = collectStringRuns(job)
    .map(normalizeShellContinuations)
    .some((script) => FLOATING_PACKAGE.test(script));
  if (!hasFloating) return null;
  return `${file.name} job ${name} installs a floating package range`;
}

function actionPinViolations(name, source, match) {
  const ref = match[1];
  if (ref.startsWith("./") || ref.startsWith(".github/")) return [];
  const [action, pin] = ref.split("@");
  if (!pin) return [`${name} uses unpinned ${action}`];
  const violations = [];
  if (!FULL_SHA.test(pin)) violations.push(`${name} uses ${ref} without a full SHA`);
  if (!actionPinHasVersionComment(source, match.index)) {
    violations.push(`${name} uses ${ref} without a version comment`);
  }
  return violations;
}

function actionPinHasVersionComment(source, index) {
  const line = source.slice(0, index).split("\n").at(-1) ?? "";
  const rest = source.slice(index).split("\n")[0] ?? "";
  return /# v?\d/.test(`${line}${rest}`);
}

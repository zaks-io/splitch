import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ACTION_FILENAMES = new Set(["action.yml", "action.yaml"]);
const WORKFLOW_EXTENSIONS = new Set([".yml", ".yaml"]);
const FLOATING_PACKAGE =
  /(?:npm|pnpm|yarn|npx|pip|uv|cargo)\s+(?:install|add|exec)\s[^\n]*@[\^~*]|npm@[\^~]|npm@(?:latest|next)\b/;
export const MUTABLE_INSTALLER = /curl[^\n]*\|\s*(?:ba)?sh\b/;
const FULL_SHA = /^[0-9a-f]{40}$/;

const ACTION_USES = /uses:\s+(\S+)/g;
const RUN_KEY = /^(\s*(?:-\s+)?)(?:["']run["']|run):\s*(.*)$/;

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
 * Collect every `run` mapping value, resolving plain, quoted, literal, and
 * folded YAML scalars. Block contents are consumed so a `run:` inside a script
 * is not treated as another key.
 *
 * @param {string} source
 * @returns {string[]}
 */
export function extractRunScripts(source) {
  const scripts = [];
  const lines = source.split(/\r?\n/);
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim() || /^\s*#/.test(line)) {
      index += 1;
      continue;
    }
    const match = line.match(RUN_KEY);
    if (!match) {
      index += 1;
      continue;
    }
    const parsed = readYamlScalar(match[2] ?? "", lines, index + 1, match[1].length);
    if (parsed.value) scripts.push(parsed.value);
    index = parsed.nextIndex;
  }
  return scripts;
}

function jobBodies(source) {
  return [
    ...source.matchAll(/\n {2}([A-Za-z][\w-]*):\n([\s\S]*?)(?=\n {2}(?:#|[A-Za-z][\w-]*:\n)|$)/g),
  ].map(([, name, body]) => ({ name, body }));
}

function isPrivileged(workflow, job) {
  return (
    /id-token:\s*write/.test(workflow) ||
    /id-token:\s*write/.test(job) ||
    /environment:\s*production/.test(job) ||
    /environment:\s*shared-preview/.test(job)
  );
}

function isOidcEnabled(workflow, job) {
  return /id-token:\s*write/.test(workflow) || /id-token:\s*write/.test(job);
}

function isPrivilegedFile(file) {
  return (
    file.kind === "action" ||
    jobBodies(file.source).some((job) => isPrivileged(file.source, job.body))
  );
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
  return files.flatMap((file) =>
    jobBodies(file.source)
      .map((job) => floatingPackageViolationForJob(file, job))
      .filter((violation) => violation !== null),
  );
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

function mutableInstallerViolationsForFile(file) {
  if (!isPrivilegedFile(file)) return [];
  const violations = extractRunScripts(file.source)
    .filter((script) => MUTABLE_INSTALLER.test(script))
    .map(() => `${file.name} pipes a remote installer to a shell`);
  if (/astral\.sh\/uv\/install/.test(file.source)) {
    violations.push(`${file.name} uses the mutable uv installer`);
  }
  return violations;
}

function floatingPackageViolationForJob(file, job) {
  if (!isOidcEnabled(file.source, job.body)) return null;
  const texts = [job.body, ...extractRunScripts(job.body)];
  if (!texts.some((text) => FLOATING_PACKAGE.test(text))) return null;
  return `${file.name} job ${job.name} installs a floating package range`;
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

function readYamlScalar(raw, lines, nextIndex, keyIndent) {
  const withoutComment = stripTrailingComment(raw.trimEnd());
  const block = withoutComment.match(/^([|>])([+-]?)(\d*)$/);
  if (block) {
    return readBlockScalar(lines, nextIndex, keyIndent, block[1] ?? "|");
  }
  if (withoutComment.startsWith('"')) {
    return { value: unquoteDouble(withoutComment), nextIndex };
  }
  if (withoutComment.startsWith("'")) {
    return { value: unquoteSingle(withoutComment), nextIndex };
  }
  return readPlainScalar(withoutComment, lines, nextIndex, keyIndent);
}

function readPlainScalar(first, lines, nextIndex, keyIndent) {
  const parts = [];
  if (first) parts.push(first.trim());
  let index = nextIndex;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim() || /^\s*#/.test(line) || leadingSpaces(line) <= keyIndent) break;
    parts.push(line.trim());
    index += 1;
  }
  return { value: parts.join(" "), nextIndex: index };
}

function readBlockScalar(lines, start, keyIndent, style) {
  const { collected, nextIndex } = collectBlockLines(lines, start, keyIndent);
  const body = trimTrailingEmpty(collected);
  return {
    value: style === ">" ? foldBlock(body) : body.join("\n"),
    nextIndex,
  };
}

function collectBlockLines(lines, start, keyIndent) {
  const collected = [];
  let index = start;
  let contentIndent = null;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim() === "") {
      collected.push("");
      index += 1;
      continue;
    }
    if (leadingSpaces(line) <= keyIndent) break;
    contentIndent ??= leadingSpaces(line);
    collected.push(line.slice(Math.min(contentIndent, line.length)));
    index += 1;
  }
  return { collected, nextIndex: index };
}

function trimTrailingEmpty(lines) {
  const trimmed = [...lines];
  while (trimmed.at(-1) === "") trimmed.pop();
  return trimmed;
}

function foldBlock(lines) {
  const paragraphs = [];
  let current = [];
  for (const line of lines) {
    if (line === "") {
      if (current.length > 0) {
        paragraphs.push(current.join(" "));
        current = [];
      }
      continue;
    }
    current.push(line.replace(/^\s+/, "").replace(/\s+$/, ""));
  }
  if (current.length > 0) paragraphs.push(current.join(" "));
  return paragraphs.join("\n");
}

function stripTrailingComment(text) {
  if (text.startsWith('"') || text.startsWith("'") || /^[|>]/.test(text.trim())) {
    return text.trim();
  }
  const comment = text.match(/^(.*?)\s+#/);
  return (comment?.[1] ?? text).trim();
}

function unquoteDouble(text) {
  const match = text.match(/^"(.*)"\s*$/s);
  if (!match) return text;
  return (match[1] ?? "")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

function unquoteSingle(text) {
  const match = text.match(/^'(.*)'\s*$/s);
  if (!match) return text;
  return (match[1] ?? "").replace(/''/g, "'");
}

function leadingSpaces(line) {
  return line.match(/^ */)?.[0].length ?? 0;
}

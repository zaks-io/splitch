import {
  commandBasename,
  hasUnresolvableToken,
  skipKnownFlags,
} from "./privileged-toolchain-command.mjs";
import {
  CARGO_GLOBAL_FLAGS,
  CARGO_INSTALL_FLAGS,
  NPM_FLAGS,
  PIP_FLAGS,
  UNRESOLVABLE_FLAGS,
  UV_FLAGS,
} from "./privileged-toolchain-flags.mjs";

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const NPM_INSTALL = new Set(["install", "i", "add", "ci"]);
const COREPACK_INSTALL = new Set(["prepare", "install"]);
const PYTHON_BOOL_FLAGS = new Set([
  "-I",
  "-S",
  "-E",
  "-s",
  "-u",
  "-O",
  "-OO",
  "-B",
  "-q",
  "-v",
  "-d",
  "-i",
  "-b",
  "-P",
  "-R",
  "-h",
  "-x",
  "--version",
  "--help",
]);

/**
 * @param {string[]} tokens
 * @returns {{ kind: string, packages?: string[], tokens?: string[] }}
 */
function classifyCommand(tokens) {
  if (tokens.length === 0) return { kind: "not-install" };
  const classifier = classifierFor(tokens[0] ?? "");
  if (classifier) return classifier(tokens);
  return leftoverInstaller(tokens);
}

/**
 * @param {{ kind: string, packages: string[], tokens: string[] }} install
 * @returns {boolean}
 */
function installIsExact(install) {
  if (install.kind === "cargo") return cargoIsExact(install);
  if (install.packages.length === 0) return hasImmutableLockMode(install);
  return install.packages.every((spec) => isExactSpec(spec, install.kind));
}

/**
 * @param {string[]} tokens
 * @returns {boolean}
 */
export function classifiedInstallIsUnpinned(tokens) {
  const classified = classifyCommand(tokens);
  if (classified.kind === "not-install") return false;
  if (classified.kind === "unparsed") return true;
  if ((classified.tokens ?? []).some((token) => UNRESOLVABLE_FLAGS.has(token))) return true;
  return !installIsExact(asExactInstall(classified));
}

/**
 * @param {{ kind: string, packages?: string[], tokens?: string[] }} classified
 * @returns {{ kind: string, packages: string[], tokens: string[] }}
 */
function asExactInstall(classified) {
  return {
    kind: classified.kind,
    packages: classified.packages ?? [],
    tokens: classified.tokens ?? [],
  };
}

function leftoverInstaller(tokens) {
  for (let index = 1; index < tokens.length; index += 1) {
    if (!classifierFor(tokens[index] ?? "")) continue;
    const inner = classifyCommand(tokens.slice(index));
    if (inner.kind !== "not-install") return { kind: "unparsed" };
  }
  return { kind: "not-install" };
}

function classifierFor(command) {
  const name = commandBasename(command);
  if (name === "npm" || name === "pnpm" || name === "yarn") return classifyNpm;
  if (name === "corepack") return classifyCorepack;
  if (name === "pip" || name === "pip3") return classifyPip;
  if (name === "python" || name === "python3") return classifyPython;
  if (name === "uv") return classifyUv;
  if (name === "cargo") return classifyCargo;
  return null;
}

function classifyNpm(tokens) {
  const manager = commandBasename(tokens[0] ?? "");
  const kind = manager === "pnpm" || manager === "yarn" ? manager : "npm";
  return classifyInstallVerb(tokens.slice(1), NPM_FLAGS, NPM_FLAGS, kind, NPM_INSTALL);
}

function classifyCorepack(tokens) {
  return classifyInstallVerb(tokens.slice(1), NPM_FLAGS, NPM_FLAGS, "corepack", COREPACK_INSTALL);
}

function classifyPip(tokens) {
  return classifyInstallVerb(tokens.slice(1), PIP_FLAGS, PIP_FLAGS, "pip", new Set(["install"]));
}

function classifyPython(tokens) {
  const module = pythonModuleInvocation(tokens);
  if (module === null) {
    return hasUnresolvableToken(tokens[1] ?? "") ? { kind: "unparsed" } : { kind: "not-install" };
  }
  if (module.name !== "pip" && module.name !== "pip3") {
    return hasUnresolvableToken(module.name) ? { kind: "unparsed" } : { kind: "not-install" };
  }
  return classifyPip(module.tokens);
}

function pythonModuleInvocation(tokens) {
  let index = 1;
  while (index < tokens.length) {
    const token = tokens[index] ?? "";
    if (token === "-m") {
      return { name: tokens[index + 1] ?? "", tokens: tokens.slice(index + 1) };
    }
    const span = pythonOptionSpan(token);
    if (span === 0) return null;
    index += span;
  }
  return null;
}

function pythonOptionSpan(token) {
  if (PYTHON_BOOL_FLAGS.has(token)) return 1;
  if (/^-[IESOBqvdbPRxh]+$/.test(token) && !token.includes("m") && !token.includes("c")) return 1;
  return 0;
}

function classifyUv(tokens) {
  const global = skipKnownFlags(tokens.slice(1), UV_FLAGS);
  if (global.unparsed) return { kind: "unparsed" };
  const tool = global.rest[0];
  if (tool !== "tool" && tool !== "pip") {
    if (!tool) return { kind: "not-install" };
    return hasUnresolvableToken(tool) ? { kind: "unparsed" } : { kind: "not-install" };
  }
  return classifyInstallVerb(global.rest.slice(1), UV_FLAGS, UV_FLAGS, "uv", new Set(["install"]));
}

function classifyCargo(tokens) {
  const afterToolchain = (tokens[1] ?? "").startsWith("+") ? tokens.slice(2) : tokens.slice(1);
  return classifyInstallVerb(
    afterToolchain,
    CARGO_GLOBAL_FLAGS,
    CARGO_INSTALL_FLAGS,
    "cargo",
    new Set(["install"]),
  );
}

function classifyInstallVerb(tokens, beforeFlags, afterFlags, kind, verbs) {
  const skipped = skipKnownFlags(tokens, beforeFlags);
  if (skipped.unparsed) return { kind: "unparsed" };
  const [verb, ...rest] = skipped.rest;
  if (!verb) return { kind: "not-install" };
  if (hasUnresolvableToken(verb)) return { kind: "unparsed" };
  if (!verbs.has(verb)) return { kind: "not-install" };
  const packages = extractPackages(rest, afterFlags);
  if (packages === null) return { kind: "unparsed" };
  return { kind, packages, tokens: skipped.rest };
}

function extractPackages(tokens, flags) {
  const packages = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (!token.startsWith("-")) {
      packages.push(token);
      continue;
    }
    const consumed = consumeInstallFlag(token, flags);
    if (consumed === null) return null;
    index += consumed;
  }
  return packages;
}

function consumeInstallFlag(token, flags) {
  const name = token.includes("=") ? token.slice(0, token.indexOf("=")) : token;
  const kind = flags.get(name);
  if (kind === undefined && !UNRESOLVABLE_FLAGS.has(name)) return null;
  return kind === "value" && !token.includes("=") ? 1 : 0;
}

function hasImmutableLockMode(install) {
  const verb = install.tokens[0] ?? "";
  if (install.kind === "npm") return verb === "ci";
  if (install.kind === "pnpm") {
    return verb === "ci" || (verb === "install" && install.tokens.includes("--frozen-lockfile"));
  }
  if (install.kind === "yarn") {
    return verb === "install" && install.tokens.includes("--immutable");
  }
  return false;
}

function cargoIsExact(install) {
  const version = cargoVersionFlag(install.tokens);
  const flagExact = version !== null && EXACT_VERSION.test(version);
  if (install.packages.length === 0) return flagExact;
  return install.packages.every((spec) => crateIsExact(spec, flagExact));
}

function cargoVersionFlag(tokens) {
  const index = tokens.indexOf("--version");
  if (index === -1) return null;
  return tokens[index + 1] ?? "";
}

function crateIsExact(spec, flagExact) {
  if (isExactNpmSpec(spec)) return true;
  return flagExact && !spec.includes("@") && !hasUnresolvableToken(spec);
}

function isExactSpec(spec, kind) {
  if (hasUnresolvableToken(spec)) return false;
  return kind === "pip" || kind === "uv" ? isExactEqualitySpec(spec) : isExactNpmSpec(spec);
}

function isExactNpmSpec(spec) {
  const version = npmSpecVersion(spec);
  return version !== null && EXACT_VERSION.test(version);
}

function npmSpecVersion(spec) {
  if (spec.startsWith("@")) {
    const separator = spec.indexOf("@", 1);
    return separator === -1 ? null : spec.slice(separator + 1);
  }
  const separator = spec.indexOf("@");
  return separator === -1 ? null : spec.slice(separator + 1);
}

function isExactEqualitySpec(spec) {
  const separator = spec.lastIndexOf("==");
  if (separator === -1) return false;
  return EXACT_VERSION.test(spec.slice(separator + 2));
}

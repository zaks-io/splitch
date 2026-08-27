import {
  commandSegments,
  flagKinds,
  hasUnresolvableToken,
  skipKnownFlags,
  stripWrappers,
  tokenize,
} from "./privileged-toolchain-command.mjs";

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const NPM_INSTALL = new Set(["install", "i", "add", "ci"]);
const UNRESOLVABLE_FLAGS = new Set(["-r", "--requirement", "--git"]);
const NPM_FLAGS = flagKinds(
  [
    "-g",
    "--global",
    "-h",
    "--help",
    "-s",
    "--silent",
    "-q",
    "--quiet",
    "-v",
    "--version",
    "-y",
    "--yes",
    "--activate",
    "--force",
    "--offline",
    "--prefer-offline",
    "--frozen-lockfile",
    "--ignore-scripts",
    "--no-save",
    "--save-dev",
    "--save-exact",
    "--strict-peer-dependencies",
  ],
  [
    "-C",
    "-w",
    "--cache",
    "--dir",
    "--filter",
    "--loglevel",
    "--prefix",
    "--registry",
    "--workspace",
  ],
);
const PIP_FLAGS = flagKinds(
  [
    "--user",
    "--isolated",
    "--break-system-packages",
    "--no-deps",
    "--no-cache-dir",
    "--pre",
    "-U",
    "--upgrade",
    "-q",
    "--quiet",
  ],
  ["-i", "--index-url", "--extra-index-url", "--proxy", "--root", "--target", "--prefix"],
);
const UV_FLAGS = flagKinds(
  [
    "--offline",
    "--no-cache",
    "-h",
    "--help",
    "-n",
    "-q",
    "--quiet",
    "-v",
    "--verbose",
    "--version",
    "--force",
    "--no-progress",
  ],
  [
    "--cache-dir",
    "--config-file",
    "--directory",
    "--index",
    "--index-url",
    "--project",
    "--python",
  ],
);
const CARGO_GLOBAL_FLAGS = flagKinds(
  [
    "--locked",
    "--offline",
    "--frozen",
    "-h",
    "--help",
    "-q",
    "--quiet",
    "-v",
    "--verbose",
    "--version",
  ],
  ["--color", "--config"],
);
const CARGO_INSTALL_FLAGS = flagKinds(
  ["--locked", "--offline", "--frozen", "-q", "--quiet", "-v", "--verbose", "--force", "--debug"],
  ["--bin", "--color", "--features", "--profile", "--registry", "--root", "--target", "--version"],
);

/**
 * @param {string} script
 * @param {{ env: Record<string, string>, inputs: Record<string, string> }} bindings
 * @returns {boolean}
 */
export function scriptHasUnpinnedInstall(script, bindings) {
  const env = resolveEnvMap(bindings.env, bindings.inputs);
  const resolved = { env, inputs: bindings.inputs };
  return commandSegments(script).some((command) =>
    commandHasUnpinnedInstall(substitute(command, resolved)),
  );
}

function resolveEnvMap(env, inputs) {
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => [key, substitute(value, { env, inputs })]),
  );
}

function substitute(text, bindings) {
  return text
    .replace(/\$\{\{\s*inputs\.([A-Za-z0-9_-]+)\s*\}\}/g, (match, key) =>
      Object.hasOwn(bindings.inputs, key) ? bindings.inputs[key] : match,
    )
    .replace(/\$\{\{\s*env\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (match, key) =>
      Object.hasOwn(bindings.env, key) ? bindings.env[key] : match,
    )
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, key) =>
      Object.hasOwn(bindings.env, key) ? bindings.env[key] : match,
    )
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, key) =>
      Object.hasOwn(bindings.env, key) ? bindings.env[key] : match,
    );
}

function commandHasUnpinnedInstall(command) {
  const classified = classifyCommand(stripWrappers(tokenize(command)));
  if (classified.kind === "not-install") return false;
  if (classified.kind === "unparsed") return true;
  if (classified.tokens.some((token) => UNRESOLVABLE_FLAGS.has(token))) return true;
  return !installIsExact(classified);
}

function classifyCommand(tokens) {
  if (tokens.length === 0) return { kind: "not-install" };
  const classifier = classifierFor(tokens[0] ?? "");
  if (classifier) return classifier(tokens);
  return leftoverInstaller(tokens);
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
  if (command === "npm" || command === "pnpm" || command === "yarn") return classifyNpm;
  if (command === "corepack") return classifyCorepack;
  if (command === "pip" || command === "pip3") return classifyPip;
  if (command === "python" || command === "python3") return classifyPython;
  if (command === "uv") return classifyUv;
  if (command === "cargo") return classifyCargo;
  return null;
}

function classifyNpm(tokens) {
  return classifyInstallVerb(tokens.slice(1), NPM_FLAGS, NPM_FLAGS, "npm", NPM_INSTALL);
}

function classifyCorepack(tokens) {
  return classifyInstallVerb(tokens.slice(1), NPM_FLAGS, NPM_FLAGS, "npm", new Set(["prepare"]));
}

function classifyPip(tokens) {
  return classifyInstallVerb(tokens.slice(1), PIP_FLAGS, PIP_FLAGS, "pip", new Set(["install"]));
}

function classifyPython(tokens) {
  if (tokens[1] !== "-m") {
    return hasUnresolvableToken(tokens[1] ?? "") ? { kind: "unparsed" } : { kind: "not-install" };
  }
  const name = tokens[2];
  if (name !== "pip" && name !== "pip3") {
    return hasUnresolvableToken(name ?? "") ? { kind: "unparsed" } : { kind: "not-install" };
  }
  return classifyPip(tokens.slice(2));
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

function installIsExact(install) {
  if (install.kind === "cargo") return cargoIsExact(install);
  if (install.packages.length === 0) return true;
  return install.packages.every((spec) => isExactSpec(spec, install.kind));
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
  return kind === "npm" ? isExactNpmSpec(spec) : isExactEqualitySpec(spec);
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

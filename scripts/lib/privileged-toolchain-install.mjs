const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const NPM_INSTALL = new Set(["install", "i", "add"]);
const FLAG_WITH_VALUE = new Set([
  "--prefix",
  "--python",
  "--version",
  "--index-url",
  "--extra-index-url",
  "--registry",
  "--cache",
  "--root",
  "--target",
  "--index",
  "--git",
  "--branch",
  "--rev",
  "--path",
  "--requirement",
  "-i",
  "-r",
]);

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

function commandSegments(script) {
  return script
    .replace(/\\[ \t]*\r?\n/g, "")
    .split(/\n/)
    .flatMap((line) => line.split(/\s*(?:&&|\|\||;)\s*/))
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function commandHasUnpinnedInstall(command) {
  const tokens = tokenize(command);
  const install = identifyInstaller(tokens);
  if (install === null) return false;
  if (hasUnresolvableRequirement(tokens)) return true;
  if (install.kind === "cargo") return !cargoIsExact(tokens);
  if (install.packages.length === 0) return false;
  return !install.packages.every((spec) => isExactSpec(spec, install.kind));
}

function hasUnresolvableRequirement(tokens) {
  return tokens.includes("-r") || tokens.includes("--requirement") || tokens.includes("--git");
}

function identifyInstaller(tokens) {
  if (isPythonPipInstall(tokens))
    return { kind: "pip", packages: extractPackages(tokens.slice(4)) };
  if ((tokens[0] === "pip" || tokens[0] === "pip3") && tokens[1] === "install") {
    return { kind: "pip", packages: extractPackages(tokens.slice(2)) };
  }
  if (tokens[0] === "uv" && tokens[1] === "tool" && tokens[2] === "install") {
    return { kind: "uv", packages: extractPackages(tokens.slice(3)) };
  }
  if (tokens[0] === "uv" && tokens[1] === "pip" && tokens[2] === "install") {
    return { kind: "uv", packages: extractPackages(tokens.slice(3)) };
  }
  if (tokens[0] === "cargo" && tokens[1] === "install") {
    return { kind: "cargo", packages: extractPackages(tokens.slice(2)) };
  }
  return identifyNpmFamilyInstaller(tokens);
}

function isPythonPipInstall(tokens) {
  return (
    (tokens[0] === "python" || tokens[0] === "python3") &&
    tokens[1] === "-m" &&
    (tokens[2] === "pip" || tokens[2] === "pip3") &&
    tokens[3] === "install"
  );
}

function identifyNpmFamilyInstaller(tokens) {
  if (tokens[0] === "corepack" && tokens[1] === "prepare") {
    return { kind: "npm", packages: extractPackages(tokens.slice(2)) };
  }
  if (
    (tokens[0] === "npm" || tokens[0] === "pnpm" || tokens[0] === "yarn") &&
    NPM_INSTALL.has(tokens[1] ?? "")
  ) {
    return { kind: "npm", packages: extractPackages(tokens.slice(2)) };
  }
  return null;
}

function extractPackages(tokens) {
  const packages = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (token.startsWith("-")) {
      if (FLAG_WITH_VALUE.has(token)) index += 1;
      continue;
    }
    packages.push(token);
  }
  return packages;
}

function tokenize(command) {
  return [...command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(
    (match) => match[1] ?? match[2] ?? match[3] ?? "",
  );
}

function isExactSpec(spec, kind) {
  if (/\$|\$\{\{/.test(spec)) return false;
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

function cargoIsExact(tokens) {
  const versionIndex = tokens.indexOf("--version");
  if (versionIndex !== -1) return EXACT_VERSION.test(tokens[versionIndex + 1] ?? "");
  return extractPackages(tokens.slice(2)).some(isExactNpmSpec);
}

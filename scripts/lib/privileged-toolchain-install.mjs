import { classifiedInstallIsUnpinned } from "./privileged-toolchain-classify.mjs";
import {
  commandSegments,
  hasUnsupportedQuoting,
  isIndirectExecution,
  stripWrappers,
  tokenize,
} from "./privileged-toolchain-command.mjs";

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
  if (hasUnsupportedQuoting(command)) return true;
  const tokens = stripWrappers(tokenize(command));
  if (isIndirectExecution(tokens)) return true;
  return classifiedInstallIsUnpinned(tokens);
}

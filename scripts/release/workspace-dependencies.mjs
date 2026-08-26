import { readFileSync } from "node:fs";
import { join } from "node:path";

const PUBLISHED_WORKSPACE_DEPENDENCIES = Object.freeze({
  "@splitch/sdk": "packages/sdk/package.json",
});

function workspacePackageVersion(packageName, repoRoot) {
  const manifestPath = PUBLISHED_WORKSPACE_DEPENDENCIES[packageName];
  if (!manifestPath) {
    throw new Error(`release manifest cannot publish private workspace dependency ${packageName}`);
  }
  const manifest = JSON.parse(readFileSync(join(repoRoot, manifestPath), "utf8"));
  if (manifest.name !== packageName || typeof manifest.version !== "string") {
    throw new Error(`${manifestPath} does not define ${packageName} with a release version`);
  }
  return manifest.version;
}

export function resolveWorkspaceDependencyRange(packageName, range, repoRoot) {
  if (!range.startsWith("workspace:")) return range;
  const version = workspacePackageVersion(packageName, repoRoot);
  const selector = range.slice("workspace:".length);
  if (selector === "*") return version;
  if (selector === "^") return `^${version}`;
  if (selector === "~") return `~${version}`;
  throw new Error(`unsupported workspace dependency range ${packageName}@${range}`);
}

export function resolvePublishedWorkspaceDependencies(manifest, repoRoot) {
  const resolved = structuredClone(manifest);
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    const dependencies = resolved[field];
    if (!dependencies) continue;
    for (const [packageName, range] of Object.entries(dependencies)) {
      dependencies[packageName] = resolveWorkspaceDependencyRange(packageName, range, repoRoot);
    }
  }
  return resolved;
}

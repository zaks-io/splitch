/**
 * @param {unknown} error
 */
function isMissingPathError(error) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

/**
 * @param {import("node:fs/promises")} fs
 * @param {import("node:path")} path
 * @param {string} repoRoot
 * @param {string} scopeDir
 * @param {string} packageName
 */
async function readWorkspacePackage(fs, path, repoRoot, scopeDir, packageName) {
  const packageJsonPath = path.join(scopeDir, packageName, "package.json");
  try {
    const manifestText = await fs.readFile(packageJsonPath, "utf8");
    return {
      packagePath: path.relative(repoRoot, packageJsonPath),
      manifest: JSON.parse(manifestText),
    };
  } catch (error) {
    if (isMissingPathError(error)) {
      return null;
    }
    throw error;
  }
}

/**
 * @param {import("node:fs/promises")} fs
 * @param {import("node:path")} path
 * @param {string} repoRoot
 * @param {string} glob
 */
async function discoverPackagesForGlob(fs, path, repoRoot, glob) {
  const [scope, wildcard] = glob.split("/");
  if (wildcard !== "*") {
    throw new Error(`Unsupported workspace glob: ${glob}`);
  }

  const scopeDir = path.join(repoRoot, scope);
  let entries;
  try {
    entries = await fs.readdir(scopeDir, { withFileTypes: true });
  } catch (error) {
    if (isMissingPathError(error)) {
      return [];
    }
    throw error;
  }

  const packages = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => readWorkspacePackage(fs, path, repoRoot, scopeDir, entry.name)),
  );

  return packages.filter((workspacePackage) => workspacePackage !== null);
}

/**
 * @param {string} repoRoot
 * @param {string[]} workspaceGlobs
 */
export async function discoverWorkspacePackages(repoRoot, workspaceGlobs) {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const packageGroups = await Promise.all(
    workspaceGlobs.map((glob) => discoverPackagesForGlob(fs, path, repoRoot, glob)),
  );
  return packageGroups
    .flat()
    .sort((left, right) => left.packagePath.localeCompare(right.packagePath));
}

/**
 * @param {string} repoRoot
 */
export async function loadPnpmWorkspaceGlobs(repoRoot) {
  const { readFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const workspaceFile = path.join(repoRoot, "pnpm-workspace.yaml");
  const text = await readFile(workspaceFile, "utf8");
  const globs = [];
  for (const line of text.split("\n")) {
    const match = /^\s*-\s+"?([^"#]+?)"?\s*$/.exec(line);
    if (match?.[1]) {
      globs.push(match[1].trim());
    }
  }
  if (globs.length === 0) {
    throw new Error("pnpm-workspace.yaml did not declare any workspace globs");
  }
  return globs;
}

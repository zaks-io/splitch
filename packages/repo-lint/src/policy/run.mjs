import { discoverWorkspacePackages, loadPnpmWorkspaceGlobs } from "./discover-workspaces.mjs";
import { lintWorkspaceDependencyPolicy, lintWorkspacePublishability } from "./publishability.mjs";
import { lintSdkReleaseMetadata } from "./sdk-metadata.mjs";

/**
 * @param {import("./constants.mjs").WorkspacePackage[]} packages
 */
export function lintPublishingPolicy(packages) {
  return [
    ...lintWorkspacePublishability(packages),
    ...lintWorkspaceDependencyPolicy(packages),
    ...packages.flatMap((workspacePackage) => lintSdkReleaseMetadata(workspacePackage)),
  ];
}

/**
 * @param {string} repoRoot
 */
export async function lintPublishingPolicyFromRepo(repoRoot) {
  const workspaceGlobs = await loadPnpmWorkspaceGlobs(repoRoot);
  const packages = await discoverWorkspacePackages(repoRoot, workspaceGlobs);
  return lintPublishingPolicy(packages);
}

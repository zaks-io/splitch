/** @typedef {Record<string, unknown> & {
 *   name?: string;
 *   version?: string;
 *   private?: boolean;
 *   type?: string;
 *   description?: string;
 *   license?: string;
 *   engines?: { node?: string };
 *   files?: string[];
 *   exports?: unknown;
 *   publishConfig?: { access?: string };
 *   dependencies?: Record<string, string>;
 *   devDependencies?: Record<string, string>;
 *   peerDependencies?: Record<string, string>;
 *   optionalDependencies?: Record<string, string>;
 * }} PackageManifest */

/** @typedef {{ packagePath: string; manifest: PackageManifest }} WorkspacePackage */

/** @typedef {{ packagePath: string; message: string }} PolicyViolation */

export const ALLOWED_PUBLISHABLE_PACKAGE = "@splitch/sdk";
export const FORBIDDEN_PUBLISHABLE_PACKAGES = new Set(["@splitch/contracts"]);
export const WORKSPACE_SCOPE = "@splitch/";
export const WORKSPACE_PROTOCOL = "workspace:";
export const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)*$/;
export const SPDX_LICENSE_PATTERN = /^[A-Za-z0-9.+()-]+$/;

export const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

/**
 * @param {string} packagePath
 * @param {string} message
 * @returns {PolicyViolation}
 */
export function violation(packagePath, message) {
  return { packagePath, message };
}

/**
 * @param {PackageManifest} manifest
 */
export function isPublishable(manifest) {
  return manifest.private !== true;
}

import { violation } from "./constants.mjs";
import {
  ALLOWED_PUBLISHABLE_PACKAGES,
  DEPENDENCY_FIELDS,
  FORBIDDEN_PUBLISHABLE_PACKAGES,
  WORKSPACE_PROTOCOL,
  WORKSPACE_SCOPE,
} from "./constants.mjs";
import { isPublishable } from "./constants.mjs";

/**
 * @param {import("./constants.mjs").WorkspacePackage[]} packages
 */
export function lintWorkspacePublishability(packages) {
  /** @type {import("./constants.mjs").PolicyViolation[]} */
  const violations = [];

  for (const { packagePath, manifest } of packages) {
    const name = manifest.name;
    if (typeof name !== "string" || name.length === 0) {
      violations.push(violation(packagePath, "package.json is missing a name field"));
      continue;
    }
    violations.push(...lintPackagePublishability(packagePath, name, manifest));
  }

  return violations;
}

/**
 * @param {string} packagePath
 * @param {string} name
 * @param {import("./constants.mjs").PackageManifest} manifest
 */
function lintPackagePublishability(packagePath, name, manifest) {
  /** @type {import("./constants.mjs").PolicyViolation[]} */
  const violations = [];

  if (FORBIDDEN_PUBLISHABLE_PACKAGES.has(name) && isPublishable(manifest)) {
    violations.push(
      violation(
        packagePath,
        `${name} must remain private and must not be publishable; set "private": true`,
      ),
    );
  }

  if (isPublishable(manifest) && !ALLOWED_PUBLISHABLE_PACKAGES.has(name)) {
    violations.push(
      violation(
        packagePath,
        `${name} is publishable but only ${[...ALLOWED_PUBLISHABLE_PACKAGES].join(", ")} may be published; set "private": true`,
      ),
    );
  }

  if (ALLOWED_PUBLISHABLE_PACKAGES.has(name) && !isPublishable(manifest)) {
    violations.push(
      violation(packagePath, `${name} must remain publishable; do not set "private": true`),
    );
  }

  return violations;
}

/**
 * @param {Record<string, string> | undefined} deps
 * @param {string} field
 * @param {string} packagePath
 */
function lintWorkspaceDependencyField(deps, field, packagePath) {
  /** @type {import("./constants.mjs").PolicyViolation[]} */
  const violations = [];
  if (!deps) {
    return violations;
  }

  for (const [dependencyName, versionRange] of Object.entries(deps)) {
    if (!dependencyName.startsWith(WORKSPACE_SCOPE)) {
      continue;
    }
    if (!versionRange.startsWith(WORKSPACE_PROTOCOL)) {
      violations.push(
        violation(
          packagePath,
          `${field}.${dependencyName} must use ${WORKSPACE_PROTOCOL}* (got ${JSON.stringify(versionRange)})`,
        ),
      );
    }
  }

  return violations;
}

/**
 * @param {import("./constants.mjs").WorkspacePackage[]} packages
 */
export function lintWorkspaceDependencyPolicy(packages) {
  /** @type {import("./constants.mjs").PolicyViolation[]} */
  const violations = [];

  for (const { packagePath, manifest } of packages) {
    for (const field of DEPENDENCY_FIELDS) {
      violations.push(
        ...lintWorkspaceDependencyField(
          /** @type {Record<string, string> | undefined} */ (manifest[field]),
          field,
          packagePath,
        ),
      );
    }
  }

  return violations;
}

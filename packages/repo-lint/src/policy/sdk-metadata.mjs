import {
  ALLOWED_PUBLISHABLE_PACKAGE,
  DEPENDENCY_FIELDS,
  SEMVER_PATTERN,
  SPDX_LICENSE_PATTERN,
  WORKSPACE_PROTOCOL,
  WORKSPACE_SCOPE,
  violation,
} from "./constants.mjs";

/**
 * @param {unknown} exportsField
 */
function collectExportTargets(exportsField) {
  /** @type {string[]} */
  const targets = [];

  const visit = (value) => {
    if (typeof value === "string") {
      targets.push(value);
      return;
    }
    if (!value || typeof value !== "object") {
      return;
    }
    for (const entry of Object.values(value)) {
      visit(entry);
    }
  };

  visit(exportsField);
  return targets;
}

/**
 * @param {string} packagePath
 * @param {import("./constants.mjs").PackageManifest} manifest
 */
function lintSdkIdentityMetadata(packagePath, manifest) {
  /** @type {import("./constants.mjs").PolicyViolation[]} */
  const violations = [];

  if (typeof manifest.version !== "string" || !SEMVER_PATTERN.test(manifest.version)) {
    violations.push(
      violation(
        packagePath,
        `${ALLOWED_PUBLISHABLE_PACKAGE} version must be a release semver (for example 0.1.0)`,
      ),
    );
  }

  if (manifest.type !== "module") {
    violations.push(
      violation(packagePath, `${ALLOWED_PUBLISHABLE_PACKAGE} must set "type": "module" for ESM`),
    );
  }

  if (typeof manifest.description !== "string" || manifest.description.trim().length === 0) {
    violations.push(
      violation(
        packagePath,
        `${ALLOWED_PUBLISHABLE_PACKAGE} must include a non-empty description for npm consumers`,
      ),
    );
  }

  if (
    typeof manifest.license !== "string" ||
    manifest.license.trim().length === 0 ||
    !SPDX_LICENSE_PATTERN.test(manifest.license.trim())
  ) {
    violations.push(
      violation(
        packagePath,
        `${ALLOWED_PUBLISHABLE_PACKAGE} must include an SPDX license identifier (for example Apache-2.0)`,
      ),
    );
  }

  if (manifest.publishConfig?.access !== "public") {
    violations.push(
      violation(
        packagePath,
        `${ALLOWED_PUBLISHABLE_PACKAGE} must set publishConfig.access to "public"`,
      ),
    );
  }

  const nodeEngine = manifest.engines?.node;
  if (typeof nodeEngine !== "string" || nodeEngine.trim().length === 0) {
    violations.push(
      violation(
        packagePath,
        `${ALLOWED_PUBLISHABLE_PACKAGE} must declare engines.node for the supported runtime floor`,
      ),
    );
  }

  return violations;
}

/**
 * @param {string} packagePath
 * @param {string[] | undefined} files
 */
function lintSdkFilesPosture(packagePath, files) {
  /** @type {import("./constants.mjs").PolicyViolation[]} */
  const violations = [];

  if (!Array.isArray(files) || files.length === 0) {
    violations.push(
      violation(packagePath, `${ALLOWED_PUBLISHABLE_PACKAGE} must declare a files whitelist`),
    );
    return violations;
  }

  if (!files.includes("dist")) {
    violations.push(
      violation(
        packagePath,
        `${ALLOWED_PUBLISHABLE_PACKAGE} files must include "dist" so only built artifacts ship`,
      ),
    );
  }

  if (files.some((entry) => entry === "src" || entry.startsWith("src/"))) {
    violations.push(
      violation(
        packagePath,
        `${ALLOWED_PUBLISHABLE_PACKAGE} files must not ship raw source (remove src entries)`,
      ),
    );
  }

  return violations;
}

/**
 * @param {string} packagePath
 * @param {unknown} rootExport
 */
function lintSdkRootExport(packagePath, rootExport) {
  /** @type {import("./constants.mjs").PolicyViolation[]} */
  const violations = [];

  if (!rootExport || typeof rootExport !== "object") {
    violations.push(
      violation(
        packagePath,
        `${ALLOWED_PUBLISHABLE_PACKAGE} exports["."] must declare types and import targets`,
      ),
    );
    return violations;
  }

  const root = /** @type {Record<string, string>} */ (rootExport);
  if (root.import !== "./dist/index.js") {
    violations.push(
      violation(
        packagePath,
        `${ALLOWED_PUBLISHABLE_PACKAGE} exports["."].import must be "./dist/index.js"`,
      ),
    );
  }
  if (root.types !== "./dist/index.d.ts") {
    violations.push(
      violation(
        packagePath,
        `${ALLOWED_PUBLISHABLE_PACKAGE} exports["."].types must be "./dist/index.d.ts"`,
      ),
    );
  }
  if ("require" in root || "default" in root) {
    violations.push(
      violation(
        packagePath,
        `${ALLOWED_PUBLISHABLE_PACKAGE} exports["."] must be ESM-only (no require/default conditions)`,
      ),
    );
  }

  return violations;
}

/**
 * @param {string} packagePath
 * @param {import("./constants.mjs").PackageManifest} manifest
 */
function lintSdkDependencyLeaks(packagePath, manifest) {
  /** @type {import("./constants.mjs").PolicyViolation[]} */
  const violations = [];

  for (const field of DEPENDENCY_FIELDS) {
    const deps = /** @type {Record<string, string> | undefined} */ (manifest[field]);
    if (!deps) {
      continue;
    }
    for (const [dependencyName, versionRange] of Object.entries(deps)) {
      if (
        dependencyName.startsWith(WORKSPACE_SCOPE) ||
        versionRange.startsWith(WORKSPACE_PROTOCOL)
      ) {
        violations.push(
          violation(
            packagePath,
            `${ALLOWED_PUBLISHABLE_PACKAGE} must not leak private workspace dependencies in ${field} (${dependencyName})`,
          ),
        );
      }
    }
  }

  return violations;
}

/**
 * @param {string} packagePath
 * @param {unknown} exportsField
 */
function lintSdkExportSurface(packagePath, exportsField) {
  /** @type {import("./constants.mjs").PolicyViolation[]} */
  const violations = [];

  for (const target of collectExportTargets(exportsField)) {
    if (target.includes("/src/") || target.startsWith("./src")) {
      violations.push(
        violation(
          packagePath,
          `${ALLOWED_PUBLISHABLE_PACKAGE} exports must not expose workspace source paths (${target})`,
        ),
      );
    }
    if (target.includes("@splitch/")) {
      violations.push(
        violation(
          packagePath,
          `${ALLOWED_PUBLISHABLE_PACKAGE} exports must not reference private workspace packages (${target})`,
        ),
      );
    }
  }

  return violations;
}

/**
 * @param {import("./constants.mjs").WorkspacePackage} workspacePackage
 */
export function lintSdkReleaseMetadata({ packagePath, manifest }) {
  if (manifest.name !== ALLOWED_PUBLISHABLE_PACKAGE) {
    return [];
  }

  return [
    ...lintSdkIdentityMetadata(packagePath, manifest),
    ...lintSdkFilesPosture(packagePath, manifest.files),
    ...lintSdkRootExport(packagePath, manifest.exports?.["."]),
    ...lintSdkDependencyLeaks(packagePath, manifest),
    ...lintSdkExportSurface(packagePath, manifest.exports),
  ];
}

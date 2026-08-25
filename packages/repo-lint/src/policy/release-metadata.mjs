import {
  ALLOWED_PUBLISHABLE_PACKAGES,
  DEPENDENCY_FIELDS,
  SEMVER_PATTERN,
  SPDX_LICENSE_PATTERN,
  violation,
  WORKSPACE_PROTOCOL,
  WORKSPACE_SCOPE,
} from "./constants.mjs";

const CLI_RUNTIME_DEPENDENCY_FIELDS = ["dependencies", "peerDependencies", "optionalDependencies"];

function collectExportTargets(exportsField) {
  const targets = [];
  const visit = (value) => {
    if (typeof value === "string") {
      targets.push(value);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const entry of Object.values(value)) visit(entry);
  };
  visit(exportsField);
  return targets;
}

function lintIdentity(packagePath, packageName, manifest) {
  const violations = [];
  if (typeof manifest.version !== "string" || !SEMVER_PATTERN.test(manifest.version)) {
    violations.push(
      violation(packagePath, `${packageName} version must be a release semver (for example 0.1.0)`),
    );
  }
  if (manifest.type !== "module") {
    violations.push(violation(packagePath, `${packageName} must set "type": "module" for ESM`));
  }
  if (typeof manifest.description !== "string" || manifest.description.trim().length === 0) {
    violations.push(
      violation(
        packagePath,
        `${packageName} must include a non-empty description for npm consumers`,
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
        `${packageName} must include an SPDX license identifier (for example Apache-2.0)`,
      ),
    );
  }
  if (manifest.publishConfig?.access !== "public") {
    violations.push(
      violation(packagePath, `${packageName} must set publishConfig.access to "public"`),
    );
  }
  if (typeof manifest.engines?.node !== "string" || manifest.engines.node.trim().length === 0) {
    violations.push(
      violation(
        packagePath,
        `${packageName} must declare engines.node for the supported runtime floor`,
      ),
    );
  }
  return violations;
}

function lintFiles(packagePath, packageName, files) {
  const violations = [];
  if (!Array.isArray(files) || files.length === 0) {
    return [violation(packagePath, `${packageName} must declare a files whitelist`)];
  }
  if (!files.includes("dist")) {
    violations.push(
      violation(
        packagePath,
        `${packageName} files must include "dist" so only built artifacts ship`,
      ),
    );
  }
  const nonDistEntry = files.find(
    (entry) => typeof entry !== "string" || !entry.replace(/^!/, "").startsWith("dist"),
  );
  if (nonDistEntry) {
    violations.push(
      violation(
        packagePath,
        `${packageName} files must be dist-only; remove ${JSON.stringify(nonDistEntry)}`,
      ),
    );
  }
  if (files.some((entry) => entry === "src" || entry.startsWith("src/"))) {
    violations.push(
      violation(packagePath, `${packageName} files must not ship raw source (remove src entries)`),
    );
  }
  return violations;
}

function lintRootExport(packagePath, packageName, rootExport) {
  if (!rootExport || typeof rootExport !== "object") {
    return [
      violation(packagePath, `${packageName} exports["."] must declare types and import targets`),
    ];
  }
  const violations = [];
  const root = rootExport;
  if (root.import !== "./dist/index.js") {
    violations.push(
      violation(packagePath, `${packageName} exports["."].import must be "./dist/index.js"`),
    );
  }
  if (root.types !== "./dist/index.d.ts") {
    violations.push(
      violation(packagePath, `${packageName} exports["."].types must be "./dist/index.d.ts"`),
    );
  }
  if ("require" in root || "default" in root) {
    violations.push(
      violation(
        packagePath,
        `${packageName} exports["."] must be ESM-only (no require/default conditions)`,
      ),
    );
  }
  return violations;
}

function lintDependencyLeaks(packagePath, packageName, manifest) {
  const fields = packageName === "@splitch/sdk" ? DEPENDENCY_FIELDS : CLI_RUNTIME_DEPENDENCY_FIELDS;
  const violations = [];
  for (const field of fields) {
    const deps = manifest[field];
    if (!deps) continue;
    for (const [dependencyName, versionRange] of Object.entries(deps)) {
      if (
        dependencyName.startsWith(WORKSPACE_SCOPE) ||
        versionRange.startsWith(WORKSPACE_PROTOCOL)
      ) {
        violations.push(
          violation(
            packagePath,
            `${packageName} must not leak private workspace dependencies in ${field} (${dependencyName})`,
          ),
        );
      }
    }
  }
  return violations;
}

function lintExportSurface(packagePath, packageName, exportsField) {
  const violations = [];
  for (const target of collectExportTargets(exportsField)) {
    if (target.includes("/src/") || target.startsWith("./src")) {
      violations.push(
        violation(
          packagePath,
          `${packageName} exports must not expose workspace source paths (${target})`,
        ),
      );
    }
    if (target.includes("@splitch/")) {
      violations.push(
        violation(
          packagePath,
          `${packageName} exports must not reference private workspace packages (${target})`,
        ),
      );
    }
  }
  return violations;
}

function lintCliBin(packagePath, manifest) {
  if (
    JSON.stringify(manifest.bin) !==
    JSON.stringify({
      splitch: "dist/cli.js",
    })
  ) {
    return [violation(packagePath, '@splitch/cli bin must be exactly {"splitch":"dist/cli.js"}')];
  }
  return [];
}

export function lintReleaseMetadata({ packagePath, manifest }) {
  const packageName = manifest.name;
  if (!ALLOWED_PUBLISHABLE_PACKAGES.has(packageName)) return [];
  return [
    ...lintIdentity(packagePath, packageName, manifest),
    ...lintFiles(packagePath, packageName, manifest.files),
    ...lintRootExport(packagePath, packageName, manifest.exports?.["."]),
    ...lintDependencyLeaks(packagePath, packageName, manifest),
    ...lintExportSurface(packagePath, packageName, manifest.exports),
    ...(packageName === "@splitch/cli" ? lintCliBin(packagePath, manifest) : []),
  ];
}

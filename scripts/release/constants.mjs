export const RELEASE_TARGETS = Object.freeze({
  sdk: Object.freeze({
    packageName: "@splitch/sdk",
    packagePath: "packages/sdk/package.json",
    packageDir: "packages/sdk",
    tagPrefix: "sdk-v",
    buildDependencies: Object.freeze([]),
  }),
  cli: Object.freeze({
    packageName: "@splitch/cli",
    packagePath: "apps/cli/package.json",
    packageDir: "apps/cli",
    tagPrefix: "cli-v",
    // The CLI bundle inlines @splitch/sdk from its built dist.
    buildDependencies: Object.freeze(["sdk"]),
  }),
});

export function getReleaseTarget(targetKey) {
  if (!targetKey) {
    throw new Error(`release target is required; expected one of: ${Object.keys(RELEASE_TARGETS)}`);
  }
  const target = RELEASE_TARGETS[targetKey];
  if (!target) {
    throw new Error(
      `unknown release target ${JSON.stringify(targetKey)}; expected one of: ${Object.keys(RELEASE_TARGETS)}`,
    );
  }
  return target;
}

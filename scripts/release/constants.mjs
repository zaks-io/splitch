export const RELEASE_TARGETS = Object.freeze({
  sdk: Object.freeze({
    packageName: "@splitch/sdk",
    packagePath: "packages/sdk/package.json",
    packageDir: "packages/sdk",
    tagPrefix: "sdk-v",
    githubLatest: false,
    // Build inputs covered by the dist build stamp, relative to packageDir.
    stampInputs: Object.freeze([
      "src",
      "package.json",
      "tsconfig.json",
      "tsup.config.ts",
      "tsup.contract-surface.config.ts",
    ]),
  }),
  cli: Object.freeze({
    packageName: "@splitch/cli",
    packagePath: "apps/cli/package.json",
    packageDir: "apps/cli",
    tagPrefix: "cli-v",
    githubLatest: "automatic",
    // The CLI bundle inlines @splitch/sdk from its built dist, so that dist
    // is part of the CLI's stamped inputs.
    stampInputs: Object.freeze([
      "src",
      "package.json",
      "tsconfig.json",
      "tsup.config.ts",
      "../../packages/sdk/dist",
    ]),
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

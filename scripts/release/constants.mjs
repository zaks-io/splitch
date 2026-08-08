export const RELEASE_TARGETS = Object.freeze({
  sdk: Object.freeze({
    packageName: "@splitch/sdk",
    packagePath: "packages/sdk/package.json",
    packageDir: "packages/sdk",
    tagPrefix: "sdk-v",
    githubLatest: false,
    // Build inputs covered by the dist build stamp, relative to packageDir.
    // The SDK ships hand-maintained zod-free mirrors of @splitch/contracts
    // (SPL-325); every mirror source that lands in dist, plus contracts itself,
    // must be stamped so an edit invalidates the digest until rebuild.
    stampInputs: Object.freeze([
      "src",
      "package.json",
      "tsconfig.json",
      "tsconfig.contract-surface.json",
      "tsup.config.ts",
      "tsup.contract-surface.config.ts",
      "scripts/contract-surface-entry.ts",
      "scripts/contract-surface-enums.ts",
      "scripts/contract-surface-keys.ts",
      "scripts/contract-surface-validators.ts",
      "../../packages/contracts/src",
    ]),
  }),
  cli: Object.freeze({
    packageName: "@splitch/cli",
    packagePath: "apps/cli/package.json",
    packageDir: "apps/cli",
    tagPrefix: "cli-v",
    githubLatest: "automatic",
    // The CLI bundle inlines @splitch/sdk from its built dist and the other
    // workspace deps from their sources; all of them are stamped inputs.
    stampInputs: Object.freeze([
      "src",
      "package.json",
      "tsconfig.json",
      "tsup.config.ts",
      "scripts/build.mjs",
      "../../packages/sdk/dist",
      "../../packages/contracts/src",
      "../../packages/control-plane-sdk/src",
      "../../packages/db/src",
      "../../packages/observability/src",
      "../../packages/privacy/src",
      "../../packages/worker-runtime/src",
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

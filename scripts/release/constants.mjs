export const RELEASE_TARGETS = Object.freeze({
  sdk: Object.freeze({
    packageName: "@splitch/sdk",
    packagePath: "packages/sdk/package.json",
    packageDir: "packages/sdk",
    tagPrefix: "sdk-v",
    githubLatest: false,
  }),
  convex: Object.freeze({
    packageName: "@splitch/convex",
    packagePath: "packages/convex/package.json",
    packageDir: "packages/convex",
    tagPrefix: "convex-v",
    githubLatest: false,
  }),
  cloudflare: Object.freeze({
    packageName: "@splitch/cloudflare",
    packagePath: "packages/cloudflare/package.json",
    packageDir: "packages/cloudflare",
    tagPrefix: "cloudflare-v",
    githubLatest: false,
  }),
  cli: Object.freeze({
    packageName: "@splitch/cli",
    packagePath: "apps/cli/package.json",
    packageDir: "apps/cli",
    tagPrefix: "cli-v",
    githubLatest: "automatic",
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

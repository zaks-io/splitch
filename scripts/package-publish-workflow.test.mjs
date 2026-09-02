import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const targets = [
  {
    name: "cli",
    packageName: "@splitch/cli",
  },
  {
    name: "cloudflare",
    packageName: "@splitch/cloudflare",
  },
  {
    name: "convex",
    packageName: "@splitch/convex",
  },
  {
    name: "sdk",
    packageName: "@splitch/sdk",
  },
];

for (const target of targets) {
  test(`${target.packageName} publishes without creating a Linear release`, () => {
    const workflow = readFileSync(`.github/workflows/${target.name}-publish.yml`, "utf8");
    const versionOutput = `${target.name}_version`;
    const publishJob = workflow.match(/\n {2}publish:\n([\s\S]*)$/)?.[1];

    assert.ok(publishJob);
    assert.match(
      publishJob,
      /npm publish "\$RUNNER_TEMP\/npm-publish\/\$RELEASE_TARBALL" --provenance --access public --tag latest/,
    );
    assert.match(
      publishJob,
      new RegExp(`${versionOutput}: \\$\\{\\{ steps\\.target\\.outputs\\.${versionOutput} \\}\\}`),
    );
    assert.doesNotMatch(workflow, /linear-release-action/);
    assert.doesNotMatch(workflow, /LINEAR_ACCESS_KEY/);
    assert.doesNotMatch(workflow, /linear-release:/);
  });
}

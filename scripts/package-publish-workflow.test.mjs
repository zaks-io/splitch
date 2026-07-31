import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const action = "linear/linear-release-action@c0cb8354a362c24c6d3e0948f37fd66d07588e3f";

const targets = [
  {
    name: "cli",
    packageName: "@splitch/cli",
    secret: "CLI_LINEAR_ACCESS_KEY",
    includePaths:
      "apps/cli/**,packages/contracts/**,packages/control-plane-sdk/**,packages/observability/**,packages/privacy/**,packages/sdk/**,packages/worker-runtime/**",
  },
  {
    name: "sdk",
    packageName: "@splitch/sdk",
    secret: "SDK_LINEAR_ACCESS_KEY",
    includePaths: "packages/sdk/**,packages/contracts/**",
  },
];

for (const target of targets) {
  test(`${target.packageName} tracks a dedicated Linear release after npm publication`, () => {
    const workflow = readFileSync(`.github/workflows/${target.name}-publish.yml`, "utf8");
    const versionOutput = `${target.name}_version`;
    const publishJob = workflow.match(/\n {2}publish:\n([\s\S]*?)\n {2}linear-release:\n/)?.[1];
    const linearJob = workflow.match(/\n {2}linear-release:\n([\s\S]*)$/)?.[1];

    assert.ok(publishJob);
    assert.ok(linearJob);
    assert.match(publishJob, /npm publish --provenance --access public --tag latest/);
    assert.match(
      publishJob,
      new RegExp(`${versionOutput}: \\$\\{\\{ steps\\.target\\.outputs\\.${versionOutput} \\}\\}`),
    );
    assert.match(linearJob, /needs: publish/);
    assert.match(linearJob, /environment: production/);
    assert.match(linearJob, new RegExp(action));
    assert.match(linearJob, new RegExp(`access_key: \\$\\{\\{ secrets\\.${target.secret} \\}\\}`));
    assert.match(linearJob, new RegExp(`${target.secret} is required`));
    assert.match(
      linearJob,
      new RegExp(`include_paths: ${target.includePaths.replaceAll("*", "\\*")}`),
    );
    assert.match(
      linearJob,
      new RegExp(`version: \\$\\{\\{ needs\\.publish\\.outputs\\.${versionOutput} \\}\\}`),
    );
    assert.match(linearJob, /if \[ -z "\$LINEAR_RELEASE_URL" \]; then/);
    assert.match(
      linearJob,
      new RegExp(`Linear did not return an ${target.packageName} release URL`),
    );
    assert.match(linearJob, /ref: \$\{\{ github\.event\.release\.tag_name \}\}/);
    assert.match(linearJob, /fetch-depth: 0/);
    assert.match(linearJob, /GitHub Release=\$\{\{ github\.event\.release\.html_url \}\}/);
    assert.match(linearJob, /npm=https:\/\/www\.npmjs\.com\/package\/@splitch\//);
  });
}

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const ACTION_PATH = ".github/actions/setup-tinybird-cli/action.yml";
const action = readFileSync(ACTION_PATH, "utf8");
const workflows = readdirSync(".github/workflows")
  .filter((name) => name.endsWith(".yml"))
  .map((name) => ({ name, source: readFileSync(`.github/workflows/${name}`, "utf8") }));

test("the shared action installs an exact Tinybird CLI version", () => {
  assert.match(action, /default: \d+\.\d+\.\d+\n/);
  assert.match(
    action,
    /uv tool install --force --python 3\.11 "tinybird==\$\{TINYBIRD_CLI_VERSION\}"/,
  );
  assert.match(action, /tb --no-version-warning --version/);
});

test("no workflow installs the floating Tinybird CLI", () => {
  for (const { name, source } of workflows) {
    assert.doesNotMatch(source, /tinybird\.co \| sh/, `${name} installs an unpinned tb`);
  }
});

test("every Tinybird CLI install goes through the shared action", () => {
  for (const { name, source } of workflows) {
    const installs = source.match(/- name: Install Tinybird CLI\n(?: {8}.*\n)+/gu) ?? [];
    for (const install of installs) {
      assert.match(
        install,
        /uses: \.\/\.github\/actions\/setup-tinybird-cli/,
        `${name} inlines a tb install`,
      );
    }
  }
});

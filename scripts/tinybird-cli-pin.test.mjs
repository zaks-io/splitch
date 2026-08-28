import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const ACTION_PATH = ".github/actions/setup-tinybird-cli/action.yml";
const SETUP_PYTHON_SHA = "5fda3b95a4ea91299a34e894583c3862153e4b97";
const SETUP_UV_SHA = "20cfd1bf945f4377ade1205e4dbc17946fc9a30d";
const PYTHON_VERSION = "3.11.16";
const UV_VERSION = "0.12.4";
const action = readFileSync(ACTION_PATH, "utf8");
const workflows = readdirSync(".github/workflows")
  .filter((name) => name.endsWith(".yml"))
  .map((name) => ({ name, source: readFileSync(`.github/workflows/${name}`, "utf8") }));

test("the shared action installs an exact Tinybird CLI version", () => {
  assert.match(action, /default: \d+\.\d+\.\d+\n/);
  assert.match(
    action,
    /uv tool install --force --python "\$\{PYTHON_VERSION\}" "tinybird==\$\{TINYBIRD_CLI_VERSION\}"/,
  );
  assert.match(action, /tb --no-version-warning --version/);
});

test("the shared action installs uv from a SHA-pinned action at an exact version", () => {
  assert.match(action, new RegExp(`uses: astral-sh/setup-uv@${SETUP_UV_SHA} # v10\\.0\\.1`));
  assert.match(action, new RegExp(`version: "${UV_VERSION}"`));
  assert.match(action, /enable-cache: false/);
  assert.match(action, new RegExp(`UV_VERSION: ${UV_VERSION.replaceAll(".", "\\.")}`));
  assert.match(action, /uv reports '\$\{uv_version\}', expected \$\{UV_VERSION\}/);
  assert.doesNotMatch(action, /curl[^\n]*\| *sh/);
  assert.doesNotMatch(action, /astral\.sh\/uv\/install/);
});

test("the shared action installs an exact Python patch and forbids uv downloads", () => {
  assert.match(action, new RegExp(`uses: actions/setup-python@${SETUP_PYTHON_SHA} # v7\\.0\\.0`));
  assert.match(action, new RegExp(`python-version: "${PYTHON_VERSION}"`));
  assert.match(action, new RegExp(`PYTHON_VERSION: ${PYTHON_VERSION.replaceAll(".", "\\.")}`));
  assert.match(action, /python reports '\$\{python_version\}', expected \$\{PYTHON_VERSION\}/);
  assert.match(action, /UV_PYTHON_DOWNLOADS: never/);
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

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const ACTION_USES = /uses:\s+(\S+)/g;
const FULL_SHA = /^[0-9a-f]{40}$/;
const SETUP_PYTHON_SHA = "5fda3b95a4ea91299a34e894583c3862153e4b97";
const SETUP_UV_SHA = "20cfd1bf945f4377ade1205e4dbc17946fc9a30d";
const PYTHON_VERSION = "3.11.16";
const UV_VERSION = "0.12.4";
const NPM_VERSION = "11.15.0";
const TINYBIRD_ACTION = ".github/actions/setup-tinybird-cli/action.yml";
const CLOUDFLARE_PUBLISH = ".github/workflows/cloudflare-publish.yml";
const PRIVILEGED_FILES = [
  TINYBIRD_ACTION,
  CLOUDFLARE_PUBLISH,
  ".github/workflows/deploy-production.yml",
  ".github/workflows/deploy-shared-preview.yml",
];

const actions = readdirSync(".github/actions", { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => ({
    name: `.github/actions/${entry.name}/action.yml`,
    source: readFileSync(`.github/actions/${entry.name}/action.yml`, "utf8"),
  }));
const workflows = readdirSync(".github/workflows")
  .filter((name) => name.endsWith(".yml"))
  .map((name) => ({
    name: `.github/workflows/${name}`,
    source: readFileSync(`.github/workflows/${name}`, "utf8"),
  }));
const files = [...actions, ...workflows];

test("every third-party action pin is a full commit SHA with a version comment", () => {
  for (const { name, source } of files) {
    for (const match of source.matchAll(ACTION_USES)) {
      const ref = match[1];
      if (ref.startsWith("./") || ref.startsWith(".github/")) continue;
      const [action, pin] = ref.split("@");
      assert.ok(pin, `${name} uses unpinned ${action}`);
      assert.match(pin, FULL_SHA, `${name} uses ${ref} without a full SHA`);
      const line = source.slice(0, match.index).split("\n").at(-1) ?? "";
      const rest = source.slice(match.index).split("\n")[0] ?? "";
      assert.match(`${line}${rest}`, /# v?\d/, `${name} uses ${ref} without a version comment`);
    }
  }
});

test("the Tinybird composite pins exact Python and uv, then verifies both", () => {
  const action = readFileSync(TINYBIRD_ACTION, "utf8");

  assert.match(action, new RegExp(`uses: actions/setup-python@${SETUP_PYTHON_SHA} # v7\\.0\\.0`));
  assert.match(action, new RegExp(`python-version: "${PYTHON_VERSION}"`));
  assert.match(action, new RegExp(`PYTHON_VERSION: ${PYTHON_VERSION.replaceAll(".", "\\.")}`));
  assert.match(action, /python reports '\$\{python_version\}', expected \$\{PYTHON_VERSION\}/);

  assert.match(action, new RegExp(`uses: astral-sh/setup-uv@${SETUP_UV_SHA} # v10\\.0\\.1`));
  assert.match(action, new RegExp(`version: "${UV_VERSION}"`));
  assert.match(action, /enable-cache: false/);
  assert.match(action, /UV_PYTHON_DOWNLOADS: never/);
  assert.match(action, new RegExp(`UV_VERSION: ${UV_VERSION.replaceAll(".", "\\.")}`));
  assert.match(action, /uv reports '\$\{uv_version\}', expected \$\{UV_VERSION\}/);
  assert.match(
    action,
    /uv tool install --force --python "\$\{PYTHON_VERSION\}" "tinybird==\$\{TINYBIRD_CLI_VERSION\}"/,
  );
  assert.match(action, /tb --no-version-warning --version/);
  assert.match(action, /default: 4\.6\.14\n/);
  assert.equal([...action.matchAll(/^ {4}default: /gm)].length, 1);
});

test("cloudflare-publish pins and verifies exact npm without widening permissions", () => {
  const workflow = readFileSync(CLOUDFLARE_PUBLISH, "utf8");
  const publishJob = workflow.match(/\n {2}publish:\n([\s\S]*?)\n {2}linear-release:\n/)?.[1] ?? "";

  assert.match(workflow, /^permissions:\n {2}contents: read\n/m);
  assert.match(publishJob, /permissions:\n {6}contents: read\n {6}id-token: write\n/);
  assert.doesNotMatch(workflow, /write-all/);
  assert.doesNotMatch(publishJob, /packages:\s*write/);

  assert.match(publishJob, /id-token: write/);
  assert.match(publishJob, new RegExp(`NPM_VERSION: ${NPM_VERSION.replaceAll(".", "\\.")}`));
  assert.match(publishJob, /npm install --global "npm@\$\{NPM_VERSION\}"/);
  assert.match(publishJob, /npm reports '\$\{installed\}', expected \$\{NPM_VERSION\}/);
  assert.doesNotMatch(publishJob, /npm@[\^~]/);
  assert.doesNotMatch(publishJob, /npm@(?:latest|next)\b/);
});

test("privileged workflow and composite files no longer use the mutable installer", () => {
  for (const path of PRIVILEGED_FILES) {
    const source = readFileSync(path, "utf8");
    assert.doesNotMatch(source, /curl[^\n]*\|\s*(?:ba)?sh\b/, `${path} pipes a remote installer`);
    assert.doesNotMatch(source, /astral\.sh\/uv\/install/, `${path} uses the mutable uv installer`);
  }
});

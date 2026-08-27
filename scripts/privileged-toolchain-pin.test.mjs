import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  extractRunScripts,
  floatingPackageViolations,
  loadGithubCiFiles,
  MUTABLE_INSTALLER,
  mutableInstallerViolations,
  unpinnedActionViolations,
} from "./lib/privileged-toolchain-pin.mjs";

const FIXTURE_ROOT = "scripts/fixtures/privileged-toolchain-pin";
const files = loadGithubCiFiles(".github");
const workflows = files.filter((file) => file.kind === "workflow");

test("every third-party action pin is a full commit SHA with a version comment", () => {
  assert.deepEqual(unpinnedActionViolations(files), []);
});

test("no privileged job executes a mutable installer", () => {
  assert.deepEqual(mutableInstallerViolations(files), []);
});

test("no OIDC-enabled job installs a floating package range", () => {
  assert.deepEqual(floatingPackageViolations(workflows), []);
});

test("cloudflare-publish pins and verifies an exact npm version before OIDC publish", () => {
  const workflow = readFileSync(".github/workflows/cloudflare-publish.yml", "utf8");
  const publishJob = workflow.match(/\n {2}publish:\n([\s\S]*?)\n {2}linear-release:\n/)?.[1] ?? "";

  assert.match(publishJob, /id-token: write/);
  assert.match(publishJob, /NPM_VERSION: 11\.15\.0/);
  assert.match(publishJob, /npm install --global "npm@\$\{NPM_VERSION\}"/);
  assert.match(publishJob, /npm reports '\$\{installed\}', expected \$\{NPM_VERSION\}/);
  assert.doesNotMatch(publishJob, /npm@[\^~]/);
  assert.doesNotMatch(publishJob, /npm@(?:latest|next)\b/);
});

test("extractRunScripts resolves plain, quoted, literal, and folded scalars", () => {
  const source = [
    "jobs:",
    "  publish:",
    "    steps:",
    "      - run: curl -LsSf https://example.test/install.sh | sh",
    "        working-directory: .",
    "      - run: |",
    "          set -euo pipefail",
    "          echo literal",
    "      - run: >",
    "          curl -LsSf https://example.test/install.sh",
    "          | sh",
    '      - run: "echo quoted"',
    "      - run: 'echo single'",
    "      - name: not-a-run",
    "        run: |",
    "          cat <<'EOF'",
    "          run: ignored-as-key",
    "          EOF",
  ].join("\n");

  assert.deepEqual(extractRunScripts(source), [
    "curl -LsSf https://example.test/install.sh | sh",
    "set -euo pipefail\necho literal",
    "curl -LsSf https://example.test/install.sh | sh",
    "echo quoted",
    "echo single",
    "cat <<'EOF'\nrun: ignored-as-key\nEOF",
  ]);
});

test("the gate discovers .yaml workflows and rejects a curl-pipe installer", () => {
  const fixture = loadGithubCiFiles(join(FIXTURE_ROOT, "yaml-extension"));
  assert.equal(fixture.length, 1);
  assert.match(fixture[0]?.name ?? "", /\.yaml$/);
  const violations = mutableInstallerViolations(fixture);
  assert.equal(violations.length, 1);
  assert.match(violations[0] ?? "", /oidc-curl\.yaml pipes a remote installer/);
});

test("the gate rejects a privileged scalar run: curl-pipe", () => {
  const fixture = loadGithubCiFiles(join(FIXTURE_ROOT, "scalar-run"));
  const [script] = extractRunScripts(fixture[0]?.source ?? "");
  assert.match(script ?? "", MUTABLE_INSTALLER);
  const violations = mutableInstallerViolations(fixture);
  assert.equal(violations.length, 1);
  assert.match(violations[0] ?? "", /oidc-curl\.yml pipes a remote installer/);
});

test("the gate rejects a privileged folded run: > curl-pipe", () => {
  const fixture = loadGithubCiFiles(join(FIXTURE_ROOT, "folded-run"));
  const [script] = extractRunScripts(fixture[0]?.source ?? "");
  assert.match(script ?? "", MUTABLE_INSTALLER);
  assert.doesNotMatch(script ?? "", /\n/);
  const violations = mutableInstallerViolations(fixture);
  assert.equal(violations.length, 1);
  assert.match(violations[0] ?? "", /oidc-curl\.yml pipes a remote installer/);
});

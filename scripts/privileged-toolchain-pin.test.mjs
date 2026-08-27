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
  normalizeShellContinuations,
  scriptHasMutableInstaller,
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
    "set -euo pipefail\necho literal\n",
    "curl -LsSf https://example.test/install.sh | sh\n",
    "echo quoted",
    "echo single",
    "cat <<'EOF'\nrun: ignored-as-key\nEOF\n",
  ]);
});

test("extractRunScripts resolves a multiline double-quoted run through YAML", () => {
  const [script] = extractRunScripts(
    [
      "jobs:",
      "  publish:",
      "    steps:",
      '      - run: "curl -LsSf https://example.test/install.sh',
      '          | sh"',
    ].join("\n"),
  );
  assert.equal(script, "curl -LsSf https://example.test/install.sh | sh");
  assert.match(script ?? "", MUTABLE_INSTALLER);
});

test("shell continuation removal turns a literal curl/pipe split into one pipeline", () => {
  const [script] = extractRunScripts(
    [
      "jobs:",
      "  publish:",
      "    steps:",
      "      - run: |",
      "          curl -LsSf https://example.test/install.sh \\",
      "          | sh",
    ].join("\n"),
  );
  assert.match(script ?? "", /\\\n/);
  assert.doesNotMatch(script ?? "", MUTABLE_INSTALLER);
  assert.match(normalizeShellContinuations(script ?? ""), MUTABLE_INSTALLER);
  assert.equal(scriptHasMutableInstaller(script ?? ""), true);
});

test("the gate discovers .yaml workflows and rejects a curl-pipe installer", () => {
  assertFixtureViolation("yaml-extension", /oidc-curl\.yaml pipes a remote installer/);
});

test("the gate rejects a privileged scalar run: curl-pipe", () => {
  const fixture = loadGithubCiFiles(join(FIXTURE_ROOT, "scalar-run"));
  const [script] = extractRunScripts(fixture[0]?.source ?? "");
  assert.match(script ?? "", MUTABLE_INSTALLER);
  assertFixtureViolation("scalar-run", /oidc-curl\.yml pipes a remote installer/);
});

test("the gate rejects a privileged folded run: > curl-pipe", () => {
  const fixture = loadGithubCiFiles(join(FIXTURE_ROOT, "folded-run"));
  const [script] = extractRunScripts(fixture[0]?.source ?? "");
  assert.match(normalizeShellContinuations(script ?? "").replace(/\n$/, ""), MUTABLE_INSTALLER);
  assertFixtureViolation("folded-run", /oidc-curl\.yml pipes a remote installer/);
});

test("the gate rejects a privileged multiline double-quoted run: curl-pipe", () => {
  const fixture = loadGithubCiFiles(join(FIXTURE_ROOT, "multiline-quoted-run"));
  const [script] = extractRunScripts(fixture[0]?.source ?? "");
  assert.equal(script, "curl -LsSf https://example.test/install.sh | sh");
  assertFixtureViolation("multiline-quoted-run", /oidc-curl\.yml pipes a remote installer/);
});

test("the gate rejects a privileged literal run with a shell line continuation", () => {
  const fixture = loadGithubCiFiles(join(FIXTURE_ROOT, "literal-continuation-run"));
  const [script] = extractRunScripts(fixture[0]?.source ?? "");
  assert.doesNotMatch(script ?? "", MUTABLE_INSTALLER);
  assert.equal(scriptHasMutableInstaller(script ?? ""), true);
  assertFixtureViolation("literal-continuation-run", /oidc-curl\.yml pipes a remote installer/);
});

function assertFixtureViolation(name, pattern) {
  const fixture = loadGithubCiFiles(join(FIXTURE_ROOT, name));
  const violations = mutableInstallerViolations(fixture);
  assert.equal(violations.length, 1);
  assert.match(violations[0] ?? "", pattern);
}

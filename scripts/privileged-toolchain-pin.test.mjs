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

test("every third-party action pin is a full commit SHA with a version comment", () => {
  assert.deepEqual(unpinnedActionViolations(files), []);
});

test("no privileged job executes a mutable installer", () => {
  assert.deepEqual(mutableInstallerViolations(files), []);
});

test("no privileged job or composite action installs a floating package range", () => {
  assert.deepEqual(floatingPackageViolations(files), []);
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

test("the gate treats environment: preview as privileged", () => {
  assertFixtureViolation("preview-env", /oidc-curl\.yml pipes a remote installer/);
});

test("the gate treats environment: Production as privileged", () => {
  assertFixtureViolation("production-case-env", /oidc-curl\.yml pipes a remote installer/);
});

test("the gate treats a dynamic environment expression as privileged", () => {
  assertFixtureViolation("dynamic-env", /oidc-curl\.yml pipes a remote installer/);
});

test("OIDC jobs reject shorthand, ranged, unpinned, and variable installer versions", () => {
  assertRejectedJobs(
    "unpinned-installers",
    [
      "npm-shorthand",
      "npm-x-range",
      "npm-comparator",
      "pip-unpinned",
      "uv-unpinned",
      "cargo-unpinned",
      "npm-variable",
      "npm-zero",
    ],
    ["npm-exact", "pnpm-frozen"],
  );
});

test("privileged environments enforce exact installer versions without OIDC", () => {
  assertRejectedJobs(
    "privileged-env-unpinned",
    ["preview-literal", "production-case", "mapping-preview", "dynamic-env"],
    ["preview-exact"],
  );
});

test("local composite action runs.steps are scanned as privileged", () => {
  const violations = floatingPackageViolations(
    loadGithubCiFiles(join(FIXTURE_ROOT, "composite-unpinned")),
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0] ?? "", /action\.yml installs a floating package range/);
});

test("concatenated quotes and indirect shells fail closed", () => {
  assertRejectedJobs("indirect-quoting", ["concatenated-quotes", "sh-c", "eval-quoted"], []);
});

test("caller with: overrides and recursive local uses are evaluated", () => {
  const violations = floatingPackageViolations(
    loadGithubCiFiles(join(FIXTURE_ROOT, "uses-override")),
  );
  assertRejectedJobs("uses-override", ["override-latest", "relay-latest"], ["default-pin"]);
  assert.equal(
    violations.some((violation) => violation.includes("relay/action.yml")),
    true,
  );
});

test("the gate discovers nested composite actions", () => {
  const violations = floatingPackageViolations(
    loadGithubCiFiles(join(FIXTURE_ROOT, "nested-action")),
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0] ?? "", /nested\/deep\/action\.yml installs a floating package range/);
});

test("adjacent quotes, shell paths, and -xc fail closed", () => {
  assertRejectedJobs("shell-forms", ["adjacent-quotes", "bash-xc", "bin-sh-c"], []);
});

test("lock flags are manager-specific", () => {
  assertRejectedJobs(
    "lock-flags",
    ["npm-immutable", "npm-frozen", "yarn-frozen", "pnpm-immutable"],
    ["npm-ci", "pnpm-frozen", "pnpm-ci", "yarn-immutable"],
  );
});

test("corepack install and python interpreter options are gated", () => {
  assertRejectedJobs(
    "installer-grammars",
    ["corepack-install", "python-isolated-pip", "python-path-pip"],
    [],
  );
});

test("downloader-to-shell includes paths, wrappers, and wget", () => {
  const violations = mutableInstallerViolations(
    loadGithubCiFiles(join(FIXTURE_ROOT, "downloader-shell")),
  );
  assert.equal(violations.length, 3);
  for (const violation of violations) {
    assert.match(violation, /oidc-curl\.yml pipes a remote installer/);
  }
});

test("wrappers, global options, pipelines, and mixed cargo crates cannot evade the gate", () => {
  assertRejectedJobs(
    "wrapped-installers",
    [
      "npm-flag-order",
      "sudo-npm",
      "assignment-npm",
      "env-npm",
      "pip-global-opt",
      "uv-global-opt",
      "cargo-global-opt",
      "pipeline-npm",
      "cargo-mixed",
    ],
    ["npm-exact-wrapped"],
  );
});

function assertFixtureViolation(name, pattern) {
  const fixture = loadGithubCiFiles(join(FIXTURE_ROOT, name));
  const violations = mutableInstallerViolations(fixture);
  assert.equal(violations.length, 1);
  assert.match(violations[0] ?? "", pattern);
}

function assertRejectedJobs(name, rejectedJobs, allowedJobs) {
  const violations = floatingPackageViolations(loadGithubCiFiles(join(FIXTURE_ROOT, name)));
  const jobs = violations
    .filter((violation) => / job /.test(violation))
    .map((violation) => violation.replace(/^.* job /, "").replace(/ installs.*$/, ""))
    .toSorted();
  assert.deepEqual(jobs, rejectedJobs.toSorted());
  for (const job of allowedJobs) {
    assert.equal(
      violations.some((violation) => violation.includes(`job ${job} `)),
      false,
    );
  }
}

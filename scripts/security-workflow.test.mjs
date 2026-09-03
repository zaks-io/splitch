import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(".github/workflows/security.yml", "utf8");

function jobSection(name) {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  if (start === -1) return undefined;
  const rest = workflow.slice(start + 1);
  const next = rest.search(/\n {2}(?:#|[a-z][a-z0-9-]*:\n)/u);
  return next === -1 ? rest : rest.slice(0, next);
}

const semgrepJob = jobSection("sast");
const depsJob = jobSection("deps");
const alertJob = jobSection("alert");

test("daily OSV findings report without masking scanner failures", () => {
  assert.ok(depsJob);
  assert.match(depsJob, /id: osv/);
  assert.match(
    depsJob,
    /set \+e\n[\s\S]*?--entrypoint osv-scanner[\s\S]*?ghcr\.io\/google\/osv-scanner-action@sha256:[a-f0-9]{64}[\s\S]*?scan_status=\$\?\n {10}set -e/,
  );
  assert.match(depsJob, /status=\$\{scan_status\}/);
  assert.doesNotMatch(depsJob, /continue-on-error/);
  assert.match(depsJob, /hashFiles\('osv\.sarif'\) != ''/);
  assert.match(
    depsJob,
    /if \[ "\$OSV_STATUS" -ne 0 \] && \[ "\$OSV_STATUS" -ne 1 \]; then\n[\s\S]*?\n {12}exit 1\n {10}fi/,
  );
});

test("daily Semgrep findings report without masking scanner failures", () => {
  assert.ok(semgrepJob);
  assert.match(semgrepJob, /id: semgrep/);
  assert.match(
    semgrepJob,
    /set \+e\n[\s\S]*?--sarif --output semgrep\.sarif \\\n {12}--error\n {10}scan_status=\$\?\n {10}set -e/,
  );
  assert.match(semgrepJob, /status=\$\{scan_status\}/);
  assert.doesNotMatch(semgrepJob, /continue-on-error/);
  assert.match(semgrepJob, /hashFiles\('semgrep\.sarif'\) != ''/);
  assert.match(
    semgrepJob,
    /steps\.semgrep\.outputs\.status != '0' && steps\.semgrep\.outputs\.status != '1'/,
  );
  assert.match(
    semgrepJob,
    /- name: Fail on Semgrep operational error[\s\S]*?\n {10}exit 1(?:\n|$)/,
  );
});

test("scheduled scanner execution failures reach the alert job", () => {
  assert.ok(alertJob);
  assert.match(alertJob, /needs: \[deps, sast, trivy, scorecard\]/);
  assert.match(alertJob, /needs\.deps\.result == 'failure'/);
  assert.match(alertJob, /needs\.sast\.result == 'failure'/);
});

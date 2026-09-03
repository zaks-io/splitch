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
    /set \+e\n[\s\S]*?--entrypoint osv-scanner[\s\S]*?ghcr\.io\/google\/osv-scanner-action@sha256:48406c58197201fe55e56615ad9d414f85063da320e204d0b0ed460fb3908dba[\s\S]*?--recursive \\\n {12}\.\/\n {10}scan_status=\$\?\n {10}set -e/,
  );
  assert.match(depsJob, /--volume "\$\{GITHUB_WORKSPACE\}:\/src:ro"/);
  assert.match(depsJob, /--volume "\$\{RUNNER_TEMP\}\/osv-scanner:\/out"/);
  assert.match(depsJob, /--output-file=\/out\/osv\.sarif/);
  assert.match(depsJob, /status=\$\{scan_status\}/);
  assert.doesNotMatch(depsJob, /continue-on-error/);
  assert.match(depsJob, /echo "sarif=true" >> "\$GITHUB_OUTPUT"/);
  assert.match(depsJob, /echo "sarif=false" >> "\$GITHUB_OUTPUT"/);
  assert.match(depsJob, /steps\.osv\.outputs\.sarif == 'true'/);
  assert.match(depsJob, /sarif_file: \$\{\{ runner\.temp \}\}\/osv-scanner\/osv\.sarif/);
  assert.match(depsJob, /OSV_STATUS: \$\{\{ steps\.osv\.outputs\.status \}\}/);
  assert.match(
    depsJob,
    /case "\$OSV_STATUS" in\n {12}""\|\*\[!0-9\]\*\)[\s\S]*?\n {14}exit 1\n {14};;\n {10}esac/,
  );
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
  assert.match(alertJob, /if: always\(\) && github\.event_name == 'schedule'/);
  assert.match(alertJob, /needs: \[deps, sast, trivy, scorecard\]/);
  assert.match(alertJob, /needs\.deps\.result == 'failure'/);
  assert.match(alertJob, /needs\.sast\.result == 'failure'/);
  assert.match(alertJob, /needs\.trivy\.result == 'failure'/);
  assert.match(alertJob, /needs\.scorecard\.result == 'failure'/);
});

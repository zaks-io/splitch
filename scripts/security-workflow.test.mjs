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
const alertJob = jobSection("alert");

test("daily Semgrep findings report without masking scanner failures", () => {
  assert.ok(semgrepJob);
  assert.match(semgrepJob, /id: semgrep/);
  assert.match(semgrepJob, /--sarif --output semgrep\.sarif \\\n {12}--error/);
  assert.match(semgrepJob, /scan_status=\$\?/);
  assert.match(semgrepJob, /status=\$\{scan_status\}/);
  assert.doesNotMatch(semgrepJob, /continue-on-error/);
  assert.match(semgrepJob, /hashFiles\('semgrep\.sarif'\) != ''/);
  assert.match(
    semgrepJob,
    /steps\.semgrep\.outputs\.status != '0' && steps\.semgrep\.outputs\.status != '1'/,
  );
});

test("scheduled scanner execution failures reach the alert job", () => {
  assert.ok(alertJob);
  assert.match(alertJob, /needs: \[deps, sast, trivy, scorecard\]/);
  assert.match(alertJob, /needs\.sast\.result == 'failure'/);
});

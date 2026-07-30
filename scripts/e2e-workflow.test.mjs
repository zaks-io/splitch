import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(".github/workflows/e2e.yml", "utf8");

test("E2E runs nightly and on manual dispatch only", () => {
  assert.match(workflow, /schedule:\n\s+- cron: "17 9 \* \* \*"/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /pull_request:/);
  assert.doesNotMatch(workflow, /\n {2}push:/);
});

test("E2E keeps the full-stack Playwright harness and its evidence", () => {
  assert.match(workflow, /SPLITCH_PLATFORM_TARGET: pr-ci/);
  assert.match(workflow, /run: pnpm exec playwright install --with-deps chromium/);
  assert.match(workflow, /run: pnpm --filter @splitch\/control-panel test:e2e/);
  assert.match(workflow, /name: control-panel-e2e-artifacts/);
  assert.match(workflow, /if-no-files-found: error/);
});

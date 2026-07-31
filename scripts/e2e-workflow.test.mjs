import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(".github/workflows/e2e.yml", "utf8");
const turbo = JSON.parse(readFileSync("turbo.json", "utf8"));
const controlPanelPlaywright = readFileSync("apps/control-panel/playwright.config.ts", "utf8");

test("E2E runs nightly and on manual dispatch only", () => {
  assert.match(workflow, /schedule:\n\s+- cron: "17 9 \* \* \*"/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /pull_request:/);
  assert.doesNotMatch(workflow, /\n {2}push:/);
});

test("E2E reuses the Turbo remote cache for the ^build dependency graph", () => {
  assert.match(workflow, /TURBO_TOKEN: \$\{\{ secrets\.TURBO_TOKEN \}\}/);
  assert.match(workflow, /TURBO_TEAM: \$\{\{ vars\.TURBO_TEAM \}\}/);
  assert.match(
    workflow,
    /TURBO_REMOTE_CACHE_SIGNATURE_KEY: \$\{\{ secrets\.TURBO_REMOTE_CACHE_SIGNATURE_KEY \}\}/,
  );
  assert.match(workflow, /run: node scripts\/check-turbo-remote-cache-env\.mjs/);
});

test("E2E keeps the full-stack Playwright harness and its evidence", () => {
  assert.match(workflow, /SPLITCH_PLATFORM_TARGET: pr-ci/);
  assert.match(workflow, /run: pnpm exec playwright install --with-deps chromium/);
  assert.match(workflow, /run: pnpm turbo run test:e2e --filter=@splitch\/control-panel/);
  assert.deepEqual(turbo.tasks["test:e2e"].dependsOn, ["^build"]);
  assert.equal(turbo.tasks["test:e2e"].cache, false);
  assert.deepEqual(turbo.tasks["test:e2e"].env, ["SPLITCH_PLATFORM_TARGET"]);
  assert.match(controlPanelPlaywright, /workers: process\.env\.CI \? 1 : undefined/);
  assert.match(workflow, /name: control-panel-e2e-artifacts/);
  assert.match(workflow, /if-no-files-found: error/);
});

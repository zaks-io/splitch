import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(".github/workflows/nightly-verify.yml", "utf8");

test("nightly forced verify runs on schedule and manual dispatch only", () => {
  assert.match(workflow, /schedule:\n\s+- cron: "47 8 \* \* \*"/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /pull_request:/);
  assert.doesNotMatch(workflow, /\n {2}push:/);
});

test("nightly verify forces execution and rewrites signed cache entries", () => {
  assert.match(workflow, /TURBO_FORCE: "true"/);
  assert.match(workflow, /TURBO_TOKEN: \$\{\{ secrets\.TURBO_TOKEN \}\}/);
  assert.match(workflow, /TURBO_TEAM: \$\{\{ vars\.TURBO_TEAM \}\}/);
  assert.match(
    workflow,
    /TURBO_REMOTE_CACHE_SIGNATURE_KEY: \$\{\{ secrets\.TURBO_REMOTE_CACHE_SIGNATURE_KEY \}\}/,
  );
  assert.match(workflow, /run: node scripts\/check-turbo-remote-cache-env\.mjs --required/);
  assert.match(workflow, /SPLITCH_PLATFORM_TARGET: pr-ci/);
  assert.match(workflow, /run: pnpm verify:ci/);
});

test("nightly verify is signal-only and cannot mutate anything", () => {
  assert.match(workflow, /permissions:\n {2}contents: read/);
  assert.doesNotMatch(workflow, /deploy|secrets: inherit|CLOUDFLARE_API_TOKEN/);
});

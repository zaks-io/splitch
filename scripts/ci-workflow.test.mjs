import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
const verifyJob = workflow.match(/\n {2}verify:\n([\s\S]*?)\n {2}deploy-production:\n/)?.[1];
const productionCall = workflow.match(/\n {2}deploy-production:\n([\s\S]*)/)?.[1];

test("new main pushes cannot cancel or coalesce an in-flight production call", () => {
  assert.match(
    workflow,
    /group: ci-\$\{\{ github\.workflow \}\}-\$\{\{ github\.ref == 'refs\/heads\/main' && github\.run_id/,
  );
  assert.match(workflow, /cancel-in-progress: \$\{\{ github\.ref != 'refs\/heads\/main' \}\}/);
});

test("main CI warms the production build cache on the existing Verify runner", () => {
  assert.ok(verifyJob);
  assert.match(verifyJob, /if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/);
  assert.doesNotMatch(workflow, /\n {2}warm-production-build-cache:/);
  assert.doesNotMatch(verifyJob, /environment: production/);
});

test("production cache warming matches deploy build inputs without deployment credentials", () => {
  assert.ok(verifyJob);
  assert.match(verifyJob, /TURBO_TOKEN: \$\{\{ secrets\.TURBO_TOKEN \}\}/);
  assert.match(verifyJob, /TURBO_TEAM: \$\{\{ vars\.TURBO_TEAM \}\}/);
  assert.match(
    verifyJob,
    /TURBO_REMOTE_CACHE_SIGNATURE_KEY: \$\{\{ secrets\.TURBO_REMOTE_CACHE_SIGNATURE_KEY \}\}/,
  );
  assert.match(verifyJob, /SPLITCH_PLATFORM_TARGET: production/);
  assert.match(verifyJob, /CLOUDFLARE_ENV: production/);
  assert.match(verifyJob, /SPLITCH_GENERATED_WRANGLER_ENV: production/);
  assert.match(verifyJob, /SENTRY_RELEASE: \$\{\{ github\.sha \}\}/);
  assert.match(
    verifyJob,
    /run: pnpm turbo run build --filter=@splitch\/control-panel --filter=@splitch\/marketing/,
  );
  assert.match(verifyJob, /run: node scripts\/check-turbo-remote-cache-env\.mjs --required/);
  assert.doesNotMatch(verifyJob, /CLOUDFLARE_API_TOKEN|TB_TOKEN|SENTRY_AUTH_TOKEN/);
  assert.doesNotMatch(verifyJob, /run: .*deploy/);
});

test("verification remains isolated to the pr-ci platform target", () => {
  assert.ok(verifyJob);
  assert.match(verifyJob, /SPLITCH_PLATFORM_TARGET: pr-ci/);
});

test("successful main CI calls and waits for one exact production release", () => {
  assert.ok(productionCall);
  assert.match(
    productionCall,
    /if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/,
  );
  assert.match(productionCall, /uses: \.\/\.github\/workflows\/deploy-production\.yml/);
  assert.match(productionCall, /actions: read/);
  assert.match(productionCall, /deployments: read/);
  assert.match(productionCall, /release_sha: \$\{\{ github\.sha \}\}/);
  assert.match(productionCall, /ci_run_id: \$\{\{ github\.run_id \}\}/);
  assert.match(productionCall, /force_full_deploy: false/);
  assert.match(productionCall, /allow_stale_release: false/);
  assert.match(productionCall, /secrets: inherit/);
  assert.doesNotMatch(productionCall, /actions: write/);
  assert.doesNotMatch(productionCall, /\/dispatches|curl /);
  assert.doesNotMatch(workflow, /workflow_run:/);
});

test("the E2E harness stays out of the per-push hot path", () => {
  assert.doesNotMatch(workflow, /control-panel-e2e/);
  assert.doesNotMatch(workflow, /playwright/i);
});

test("the stats simulation stays out of the per-push hot path", () => {
  assert.doesNotMatch(workflow, /stats-simulation-smoke/);
  assert.doesNotMatch(workflow, /stats:simulation/);
});

test("spec lint runs only inside Verify, not as a duplicate job", () => {
  assert.doesNotMatch(workflow, /\n {2}spec-lint:/);
  assert.doesNotMatch(workflow, /run: pnpm spec:lint/);
});

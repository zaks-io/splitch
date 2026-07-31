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

test("cache-policy changes force the cache off before Verify runs", () => {
  assert.ok(verifyJob);
  const forceStepIndex = verifyJob.indexOf("name: Force cache off for cache-policy changes");
  const verifyStepIndex = verifyJob.indexOf("- name: Verify\n");
  assert.ok(forceStepIndex > -1, "forcing step must exist");
  assert.ok(verifyStepIndex > -1, "Verify step must exist");
  assert.ok(forceStepIndex < verifyStepIndex, "forcing step must run before Verify");

  const forceStep = verifyJob.slice(
    forceStepIndex,
    verifyJob.indexOf("- name: Verify\n", forceStepIndex),
  );

  // The cache-policy surface: files that govern which tasks are cached, how
  // they're keyed, or how the remote cache is validated.
  const cachePolicyPaths = [
    "turbo\\\\.json",
    "\\\\.github/workflows/ci\\\\.yml",
    "\\\\.github/workflows/nightly-verify\\\\.yml",
    "scripts/check-turbo-remote-cache-env\\\\.mjs",
  ];
  for (const path of cachePolicyPaths) {
    assert.match(forceStep, new RegExp(path), `cache-policy pattern must cover ${path}`);
  }

  assert.match(forceStep, /echo "TURBO_FORCE=true" >> "\$GITHUB_ENV"/);
  assert.match(forceStep, /::notice title=/);
});

test("cache-policy detection covers both pull_request and push triggers, forcing off when a diff can't be computed", () => {
  assert.ok(verifyJob);
  const forceStep = verifyJob.slice(
    verifyJob.indexOf("name: Force cache off for cache-policy changes"),
    verifyJob.indexOf("- name: Verify\n"),
  );

  assert.match(forceStep, /EVENT_NAME: \$\{\{ github\.event_name \}\}/);
  assert.match(forceStep, /BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(forceStep, /HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.match(forceStep, /BEFORE_SHA: \$\{\{ github\.event\.before \}\}/);
  assert.match(forceStep, /AFTER_SHA: \$\{\{ github\.sha \}\}/);

  assert.match(forceStep, /if \[ "\$EVENT_NAME" = "pull_request" \]/);
  assert.match(forceStep, /if \[ "\$EVENT_NAME" = "push" \]/);
  assert.match(forceStep, /git merge-base "\$BASE_SHA" "\$HEAD_SHA"/);
  assert.match(forceStep, /git diff --name-only "\$BEFORE_SHA" "\$AFTER_SHA"/);

  // No-comparison-available paths must force the cache off, never silently
  // proceed as if nothing changed (ADR-0036: fail loud, no silent fallback).
  const noComparisonBranches = forceStep.match(
    /force_cache_off ".*cannot diff, so the cache is not trusted\."/g,
  );
  assert.ok(noComparisonBranches);
  assert.equal(
    noComparisonBranches.length,
    4,
    "every no-comparison branch (missing PR shas, no merge base, missing push before-sha, unrecognized event) must force the cache off",
  );
});

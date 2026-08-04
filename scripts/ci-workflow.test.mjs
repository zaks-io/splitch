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

test("Verify keeps its stable check name on the measured 8 vCPU runner", () => {
  assert.ok(verifyJob);
  assert.match(verifyJob, /name: Verify/);
  assert.match(verifyJob, /runs-on: blacksmith-8vcpu-ubuntu-2404/);
});

test("main CI delegates production build selection to the production deploy planner", () => {
  assert.ok(verifyJob);
  assert.doesNotMatch(verifyJob, /Build production-target Vite Workers/);
  assert.doesNotMatch(verifyJob, /SPLITCH_PLATFORM_TARGET: production/);
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

test("one plan step controls affected verification and conditional validators", () => {
  assert.ok(verifyJob);
  const planStepIndex = verifyJob.indexOf("name: Plan CI verification");
  const verifyStepIndex = verifyJob.indexOf("- name: Verify\n");
  assert.ok(planStepIndex > -1, "planning step must exist");
  assert.ok(verifyStepIndex > -1, "Verify step must exist");
  assert.ok(planStepIndex < verifyStepIndex, "planning step must run before Verify");
  assert.match(verifyJob, /id: plan/);
  assert.match(verifyJob, /run: node scripts\/plan-ci-verification\.mjs/);
  assert.match(verifyJob, /if: steps\.plan\.outputs\.tinybird == 'true'/);
  assert.match(verifyJob, /run: pnpm tinybird:local/);
  assert.match(verifyJob, /if: steps\.plan\.outputs\.d1 == 'true'/);
  assert.match(verifyJob, /run: pnpm d1:migrate:local && pnpm d1:migrate:populated/);
  assert.match(verifyJob, /pnpm verify:ci --affected --output-logs=new-only/);
  assert.match(verifyJob, /pnpm verify:ci --output-logs=new-only/);
});

test("CI planning receives exact pull request and push range endpoints", () => {
  assert.ok(verifyJob);
  const planStep = verifyJob.slice(
    verifyJob.indexOf("name: Plan CI verification"),
    verifyJob.indexOf("- name: Verify\n"),
  );

  assert.match(planStep, /PR_BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(planStep, /PR_HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.match(planStep, /PUSH_BEFORE_SHA: \$\{\{ github\.event\.before \}\}/);
  assert.match(planStep, /PUSH_AFTER_SHA: \$\{\{ github\.sha \}\}/);
});

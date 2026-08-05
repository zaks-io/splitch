import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(".github/workflows/ci.yml", "utf8");

// Job bodies are sliced by top-level job key rather than by a fixed pair of
// delimiters so that adding a job between two others cannot silently widen an
// earlier job's assertions to cover it.
function jobSection(name) {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  if (start === -1) return undefined;
  const rest = workflow.slice(start + 1);
  // Job bodies are indented 4+, so a 2-space comment is always a between-jobs
  // banner and must not leak into the preceding job's body.
  const next = rest.search(/\n {2}(?:#|[a-z][a-z0-9-]*:\n)/u);
  return next === -1 ? rest : rest.slice(0, next);
}

const verifyJob = jobSection("verify");
const tinybirdJob = jobSection("tinybird");
const d1Job = jobSection("d1");
const productionCall = jobSection("deploy-production");

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

test("the plan step gates affected verification and runs before Verify", () => {
  assert.ok(verifyJob);
  const planStepIndex = verifyJob.indexOf("name: Plan CI verification");
  const verifyStepIndex = verifyJob.indexOf("- name: Verify\n");
  assert.ok(planStepIndex > -1, "planning step must exist");
  assert.ok(verifyStepIndex > -1, "Verify step must exist");
  assert.ok(planStepIndex < verifyStepIndex, "planning step must run before Verify");
  assert.match(verifyJob, /id: plan/);
  assert.match(verifyJob, /pnpm verify:ci --affected --output-logs=new-only/);
  assert.match(verifyJob, /pnpm verify:ci --output-logs=new-only/);
});

test("the slow validators run beside Verify instead of ahead of it", () => {
  assert.ok(verifyJob);
  assert.ok(tinybirdJob);
  assert.ok(d1Job);

  // The whole point of the split: Verify must not carry either validator, and
  // neither validator may wait on Verify.
  assert.doesNotMatch(verifyJob, /tinybird|d1:migrate/i);
  assert.doesNotMatch(tinybirdJob, /\n {4}needs:/u);
  assert.doesNotMatch(d1Job, /\n {4}needs:/u);

  assert.match(tinybirdJob, /if: steps\.plan\.outputs\.tinybird == 'true'/);
  assert.match(tinybirdJob, /run: pnpm tinybird:local/);
  assert.match(d1Job, /if: steps\.plan\.outputs\.d1 == 'true'/);
  assert.match(d1Job, /run: pnpm d1:migrate:local && pnpm d1:migrate:populated/);
});

test("skipping a validator cannot skip the production deploy that needs it", () => {
  assert.ok(tinybirdJob);
  assert.ok(d1Job);
  // A job-level `if:` would resolve to `skipped`, and a skipped `needs` entry
  // skips deploy-production. Both jobs must always run and gate per step.
  assert.doesNotMatch(tinybirdJob, /\n {4}if:/u);
  assert.doesNotMatch(d1Job, /\n {4}if:/u);
  assert.match(productionCall, /needs:\n {6}- verify\n {6}- tinybird\n {6}- d1\n/u);
});

test("the Tinybird validator stays off the workspace dependency graph", () => {
  assert.ok(tinybirdJob);
  // check-tinybird-local.mjs and its helpers import node builtins only, so
  // installing the workspace here would buy nothing and re-couple this job to
  // every lockfile bump.
  assert.doesNotMatch(tinybirdJob, /run: pnpm install/);
  assert.doesNotMatch(tinybirdJob, /cache: pnpm/);
  assert.match(d1Job, /run: pnpm install --frozen-lockfile/);
});

test("every job plans from the exact pull request and push range endpoints", () => {
  for (const job of [verifyJob, tinybirdJob, d1Job]) {
    assert.ok(job);
    const planStep = job.slice(job.indexOf("name: Plan CI verification"));
    assert.match(planStep, /run: node scripts\/plan-ci-verification\.mjs/);
    assert.match(planStep, /PR_BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
    assert.match(planStep, /PR_HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
    assert.match(planStep, /PUSH_BEFORE_SHA: \$\{\{ github\.event\.before \}\}/);
    assert.match(planStep, /PUSH_AFTER_SHA: \$\{\{ github\.sha \}\}/);
    // The planner diffs against a merge base, which a shallow clone cannot resolve.
    assert.match(job, /fetch-depth: 0/);
  }
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(".github/workflows/deploy-production.yml", "utf8");
const validateJob = workflow.match(/\n {2}validate:\n([\s\S]*?)\n {2}deploy:\n/)?.[1];
const releaseJob = workflow.match(/\n {2}release:\n([\s\S]*)$/)?.[1];

test("production deploy reuses successful CI instead of rerunning validation", () => {
  assert.ok(validateJob);
  assert.match(workflow, /workflow_call:/);
  assert.match(workflow, /actions: read/);
  assert.match(workflow, /deployments: read/);
  assert.doesNotMatch(workflow, /workflow_run:/);
  assert.match(workflow, /SENTRY_RELEASE: \$\{\{ inputs\.release_sha \|\| github\.sha \}\}/);
  assert.match(workflow, /CI_RUN_ID: \$\{\{ inputs\.ci_run_id \}\}/);
  assert.match(workflow, /force_full_deploy:/);
  assert.match(workflow, /allow_stale_release:/);
  assert.match(workflow, /SPLITCH_FORCE_FULL_DEPLOY:/);
  assert.match(validateJob, /actions\/workflows\/ci\.yml\/runs/);
  assert.match(validateJob, /TRIGGER_EVENT: \$\{\{ github\.event_name \}\}/);
  assert.match(validateJob, /CURRENT_RUN_ID: \$\{\{ github\.run_id \}\}/);
  assert.match(validateJob, /if \[ "\$TRIGGER_EVENT" = "push" \]; then/);
  assert.match(validateJob, /CI_RUN_ID.*CURRENT_RUN_ID/);
  assert.match(validateJob, /RELEASE_SHA.*GITHUB_SHA/);
  assert.match(validateJob, /--data-urlencode "head_sha=\$RELEASE_SHA"/);
  assert.match(validateJob, /\.head_sha == \$sha/);
  assert.match(validateJob, /\.event == "push"/);
  assert.match(validateJob, /\.conclusion == "success"/);
  assert.doesNotMatch(validateJob, /repos\/\$GITHUB_REPOSITORY\/actions\/runs\/\$CI_RUN_ID/);
  assert.doesNotMatch(validateJob, /sleep 5/);
  assert.doesNotMatch(validateJob, /Verify manual deploy/);
  assert.doesNotMatch(validateJob, /run: pnpm verify:ci/);
  assert.doesNotMatch(validateJob, /name: Setup pnpm/);
  assert.doesNotMatch(validateJob, /name: Setup Node/);
  assert.doesNotMatch(validateJob, /name: Install/);
  assert.doesNotMatch(validateJob, /Check Turbo remote cache inputs/);
});

test("production deploy rejects stale releases unless recovery is explicit", () => {
  assert.ok(validateJob);
  assert.match(validateJob, /name: Reject stale release without explicit recovery/);
  assert.match(validateJob, /ALLOW_STALE_RELEASE: \$\{\{ inputs\.allow_stale_release/);
  assert.match(validateJob, /git\/ref\/heads\/main/);
  assert.match(validateJob, /RELEASE_SHA.*current_main_sha/);
  assert.match(validateJob, /ALLOW_STALE_RELEASE.*"1"/);
  assert.match(validateJob, /This does not roll back D1, KV, Durable Objects, Queues, or Tinybird/);
  assert.match(workflow, /name: Revalidate current release after production gate/);
  assert.equal(workflow.match(/git\/ref\/heads\/main/g)?.length, 2);
  assert.ok(
    workflow.indexOf("Revalidate current release after production gate") <
      workflow.indexOf("Deploy Tinybird"),
  );
});

test("superseded continuous releases skip cleanly instead of failing the run", () => {
  assert.ok(validateJob);
  assert.match(validateJob, /id: freshness/);
  assert.match(
    validateJob,
    /if \[ "\$TRIGGER_EVENT" = "push" \]; then\n\s+echo "superseded=true" >> "\$GITHUB_OUTPUT"/,
  );
  assert.match(validateJob, /was superseded by \$current_main_sha before deploying; skipping/);
  const guardedValidateSteps = [
    "Checkout",
    "Verify checked out release commit",
    "Verify successful CI for release commit",
    "Plan production deploy",
    "Summary",
  ];
  for (const step of guardedValidateSteps) {
    assert.match(
      validateJob,
      new RegExp(`name: ${step}\\n\\s+if: steps\\.freshness\\.outputs\\.superseded != 'true'`),
      `validate step "${step}" must skip once the release is superseded`,
    );
  }
  assert.match(workflow, /id: revalidate/);
  assert.match(
    workflow,
    /was superseded by \$current_main_sha while waiting for the production gate; skipping/,
  );
  assert.match(
    workflow,
    /if: needs\.validate\.outputs\.tinybird == 'true' && steps\.revalidate\.outputs\.superseded != 'true'/,
  );
  assert.match(
    workflow,
    /if: needs\.validate\.outputs\.d1 == 'true' && steps\.revalidate\.outputs\.superseded != 'true'/,
  );
  assert.match(
    workflow,
    /if: needs\.validate\.outputs\.workers == 'true' && steps\.revalidate\.outputs\.superseded != 'true'/,
  );
  assert.match(workflow, /superseded: \$\{\{ steps\.revalidate\.outputs\.superseded \}\}/);
  assert.ok(releaseJob);
  assert.match(releaseJob, /if: needs\.deploy\.outputs\.superseded != 'true'/);
  const dispatchStillFails = /if \[ "\$ALLOW_STALE_RELEASE" != "1" \]; then\n\s+echo "::error::/g;
  assert.equal(
    workflow.match(dispatchStillFails)?.length,
    2,
    "explicit dispatch of a stale SHA must still fail loudly in both guards",
  );
});

test("the unstable nightly E2E never blocks production deploys", () => {
  assert.doesNotMatch(workflow, /e2e\.yml/);
  assert.doesNotMatch(workflow, /Verify recent E2E success/);
});

test("production deploy plans from the latest successful environment deployment", () => {
  assert.match(validateJob, /name: Plan production deploy/);
  assert.match(validateJob, /id: plan/);
  assert.match(validateJob, /run: node scripts\/plan-production-deploy\.mjs/);
  assert.match(
    workflow,
    /should_deploy: \$\{\{ steps\.freshness\.outputs\.superseded == 'true' && 'false' \|\| steps\.plan\.outputs\.should_deploy \}\}/,
  );
  assert.match(workflow, /worker_packages: \$\{\{ steps\.plan\.outputs\.worker_packages \}\}/);
  assert.match(workflow, /if: needs\.validate\.outputs\.should_deploy == 'true'/);
});

test("production deploy runs only planned mutation phases in contract order", () => {
  assert.match(
    workflow,
    /name: Deploy Tinybird[\s\S]*if: needs\.validate\.outputs\.tinybird == 'true'[\s\S]*run: pnpm tinybird:deploy:production/,
  );
  assert.match(
    workflow,
    /name: Apply D1 migrations[\s\S]*if: needs\.validate\.outputs\.d1 == 'true'[\s\S]*run: pnpm d1:migrate:production/,
  );
  assert.match(
    workflow,
    /name: Deploy Cloudflare Workers[\s\S]*if: needs\.validate\.outputs\.workers == 'true'[\s\S]*run: node scripts\/deploy-cloudflare-workers\.mjs production "\$WORKER_PACKAGES"/,
  );
  assert.doesNotMatch(workflow, /run: pnpm deploy:production/);
  assert.match(workflow, /TINYBIRD_OUTCOME: \$\{\{ steps\.tinybird\.outcome \}\}/);
  assert.match(workflow, /D1_OUTCOME: \$\{\{ steps\.d1\.outcome \}\}/);
  assert.match(workflow, /WORKERS_OUTCOME: \$\{\{ steps\.workers\.outcome \}\}/);
});

test("production deploy does not run unsupported per-job Harden Runner installation on Blacksmith", () => {
  assert.doesNotMatch(workflow, /step-security\/harden-runner/);
  assert.doesNotMatch(workflow, /name: Harden runner/);
});

test("phase-specific setup and credentials stay conditional", () => {
  assert.match(
    workflow,
    /name: Setup Node[\s\S]*if: needs\.validate\.outputs\.d1 == 'true' \|\| needs\.validate\.outputs\.workers == 'true'/,
  );
  assert.match(
    workflow,
    /name: Install Tinybird CLI[\s\S]*if: needs\.validate\.outputs\.tinybird == 'true'/,
  );
  assert.match(workflow, /required\+=\(TB_TOKEN TB_HOST\)/);
  assert.match(workflow, /required\+=\(CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID\)/);
  assert.match(workflow, /if \[ "\$DEPLOY_WORKERS" = "true" \]; then/);
});

test("platform release tracking reads its key from the production environment", () => {
  assert.ok(validateJob);
  assert.ok(releaseJob);
  assert.doesNotMatch(validateJob, /LINEAR_ACCESS_KEY/);
  assert.match(releaseJob, /environment: production/);
  assert.match(releaseJob, /LINEAR_ACCESS_KEY: \$\{\{ secrets\.LINEAR_ACCESS_KEY \}\}/);
  assert.match(releaseJob, /LINEAR_ACCESS_KEY is required to track platform releases/);
  assert.match(releaseJob, /needs: deploy/);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(".github/workflows/deploy-production.yml", "utf8");
const validateJob = workflow.match(/\n {2}validate:\n([\s\S]*?)\n {2}deploy:\n/)?.[1];

test("production deploy reuses successful CI instead of rerunning validation", () => {
  assert.ok(validateJob);
  assert.match(workflow, /actions: read/);
  assert.match(workflow, /deployments: read/);
  assert.doesNotMatch(workflow, /workflow_run:/);
  assert.match(workflow, /SENTRY_RELEASE: \$\{\{ inputs\.release_sha \|\| github\.sha \}\}/);
  assert.match(workflow, /CI_RUN_ID: \$\{\{ inputs\.ci_run_id \}\}/);
  assert.match(workflow, /force_full_deploy:/);
  assert.match(workflow, /SPLITCH_FORCE_FULL_DEPLOY:/);
  assert.match(validateJob, /actions\/workflows\/ci\.yml\/runs/);
  assert.match(validateJob, /actions\/runs\/\$CI_RUN_ID/);
  assert.match(validateJob, /run_sha.*RELEASE_SHA/);
  assert.match(validateJob, /run_conclusion.*success/);
  assert.match(validateJob, /--data-urlencode "head_sha=\$RELEASE_SHA"/);
  assert.match(validateJob, /\.head_sha == \$sha/);
  assert.match(validateJob, /\.event == "push"/);
  assert.match(validateJob, /\.conclusion == "success"/);
  assert.doesNotMatch(validateJob, /Verify manual deploy/);
  assert.doesNotMatch(validateJob, /run: pnpm verify:ci/);
  assert.doesNotMatch(validateJob, /name: Setup pnpm/);
  assert.doesNotMatch(validateJob, /name: Setup Node/);
  assert.doesNotMatch(validateJob, /name: Install/);
  assert.doesNotMatch(validateJob, /Check Turbo remote cache inputs/);
});

test("production deploy plans from the latest successful environment deployment", () => {
  assert.match(validateJob, /name: Plan production deploy/);
  assert.match(validateJob, /id: plan/);
  assert.match(validateJob, /run: node scripts\/plan-production-deploy\.mjs/);
  assert.match(workflow, /should_deploy: \$\{\{ steps\.plan\.outputs\.should_deploy \}\}/);
  assert.match(workflow, /worker_packages: \$\{\{ steps\.plan\.outputs\.worker_packages \}\}/);
  assert.match(workflow, /if: needs\.validate\.outputs\.should_deploy == 'true'/);
  assert.match(validateJob, /if: steps\.plan\.outputs\.should_deploy == 'true'/);
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

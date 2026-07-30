import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(".github/workflows/deploy-production.yml", "utf8");
const validateJob = workflow.match(/\n  validate:\n([\s\S]*?)\n  deploy:\n/)?.[1];

test("production deploy reuses successful CI instead of rerunning validation", () => {
  assert.ok(validateJob);
  assert.match(workflow, /actions: read/);
  assert.match(workflow, /github\.event\.workflow_run\.conclusion == 'success'/);
  assert.match(workflow, /github\.event\.workflow_run\.head_sha/);
  assert.match(validateJob, /if: github\.event_name == 'workflow_dispatch'/);
  assert.match(validateJob, /actions\/workflows\/ci\.yml\/runs/);
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

test("production deploy exposes each ordered mutation as its own timed step", () => {
  assert.match(workflow, /name: Deploy Tinybird[\s\S]*run: pnpm tinybird:deploy:production/);
  assert.match(workflow, /name: Apply D1 migrations[\s\S]*run: pnpm d1:migrate:production/);
  assert.match(
    workflow,
    /name: Deploy Cloudflare Workers[\s\S]*run: pnpm deploy:cloudflare:production/,
  );
  assert.doesNotMatch(workflow, /run: pnpm deploy:production/);
  assert.match(workflow, /TINYBIRD_OUTCOME: \$\{\{ steps\.tinybird\.outcome \}\}/);
  assert.match(workflow, /D1_OUTCOME: \$\{\{ steps\.d1\.outcome \}\}/);
  assert.match(workflow, /WORKERS_OUTCOME: \$\{\{ steps\.workers\.outcome \}\}/);
});

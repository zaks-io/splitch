import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createFleetEvidence,
  resolveDeployedCommitSha,
  verifyHealthObservation,
} from "./lib/shared-preview-deployment-evidence.mjs";

const sha = "a".repeat(40);
const staleSha = "b".repeat(40);
const routes = [route("Auth", "splitch-auth-api"), route("MCP", "splitch-mcp-server")];

test("accepts one exact deployed commit across the exercised Worker fleet", () => {
  const evidence = createFleetEvidence({
    expectedCommitSha: sha,
    expectedPlatformTarget: "shared-preview",
    observations: routes.map((route) => ({ body: health(route.service, sha), route })),
  });
  assert.equal(evidence.deployedCommitSha, sha);
  assert.deepEqual(evidence.routes, routes);
});

test("fails loud for a mixed or stale Worker fleet", () => {
  assert.throws(
    () =>
      createFleetEvidence({
        expectedCommitSha: sha,
        expectedPlatformTarget: "shared-preview",
        observations: [
          { body: health(routes[0].service, sha), route: routes[0] },
          { body: health(routes[1].service, staleSha), route: routes[1] },
        ],
      }),
    /MCP reported deployed commit/,
  );
});

test("a checked-out workflow ref cannot substitute for deployed revision evidence", () => {
  assert.throws(
    () =>
      verifyHealthObservation({
        body: { ok: true, platformTarget: "shared-preview", service: routes[0].service },
        expectedCommitSha: sha,
        expectedPlatformTarget: "shared-preview",
        route: routes[0],
      }),
    /reported deployed commit undefined/,
  );
});

test("resolves the current deployed SHA only from valid shared-preview health metadata", () => {
  assert.equal(
    resolveDeployedCommitSha({
      body: health(routes[0].service, sha),
      expectedPlatformTarget: "shared-preview",
      route: routes[0],
    }),
    sha,
  );
  assert.throws(
    () =>
      resolveDeployedCommitSha({
        body: health(routes[0].service, "not-a-sha"),
        expectedPlatformTarget: "shared-preview",
        route: routes[0],
      }),
    /deployed commit SHA must be a full lowercase commit SHA/,
  );
});

test("smoke and reset summaries retain the independently verified deployed SHA", () => {
  const fixture = mkdtempSync(join(tmpdir(), "splitch-shared-preview-evidence-"));
  const evidencePath = join(fixture, "evidence.json");
  writeFileSync(
    evidencePath,
    JSON.stringify({
      deployedCommitSha: sha,
      platformTarget: "shared-preview",
      routes,
    }),
  );

  const smoke = summary("smoke", evidencePath, sha);
  assert.equal(smoke.status, 0, smoke.stderr);
  assert.match(smoke.stdout, new RegExp(String.raw`Deployed commit SHA: \`${sha}\``));
  assert.match(smoke.stdout, /Seed outcome: `success`/);
  assert.match(smoke.stdout, /Dark-launch outcome: `success`/);
  assert.match(smoke.stdout, /Failure artifact outcome: `skipped`/);
  assert.match(smoke.stdout, /Tinybird Branch/);
  assert.match(smoke.stdout, /Applied D1 migrations/);

  const reset = summary("reset", evidencePath, staleSha);
  assert.equal(reset.status, 0, reset.stderr);
  assert.match(reset.stdout, new RegExp(String.raw`Workflow ref: \`${staleSha}\``));
  assert.match(reset.stdout, new RegExp(String.raw`Deployed commit SHA: \`${sha}\``));
});

test("shared-preview deploy keeps every post-deploy smoke phase non-blocking", () => {
  const workflow = readFileSync(".github/workflows/deploy-shared-preview.yml", "utf8");
  const jobs = workflow.slice(workflow.indexOf("\njobs:\n"));
  const deployJob = workflow.match(/\n {2}deploy:\n([\s\S]*)$/)?.[1];

  assert.ok(deployJob);
  assert.match(workflow, /deployed_sha="\$\(git rev-parse HEAD\)"/);
  assert.match(workflow, /SPLITCH_DEPLOYED_COMMIT_SHA=\$deployed_sha/);
  assert.doesNotMatch(jobs, /\n {2}(?!deploy:)[a-z0-9_-]+:\n/);
  assert.match(
    deployJob,
    /name: Seed shared preview smoke data\n\s+id: seed\n\s+continue-on-error: true/,
  );
  assert.match(
    deployJob,
    /name: Smoke shared preview\n\s+id: smoke\n\s+if: steps\.seed\.outcome == 'success'\n\s+continue-on-error: true/,
  );
  assert.match(
    deployJob,
    /name: Dark-launch shared preview\n\s+id: dark_launch\n\s+if: steps\.smoke\.outcome == 'success'\n\s+continue-on-error: true/,
  );
  assert.match(
    deployJob,
    /SPLITCH_SMOKE_COMMIT_SHA="\$SPLITCH_DEPLOYED_COMMIT_SHA" pnpm shared-preview:smoke/,
  );
  assert.match(deployJob, /pnpm smoke:dark-launch:shared-preview/);
  assert.match(deployJob, /SPLITCH_SMOKE_RUNS: "2"/);
  assert.match(
    deployJob,
    /if: always\(\)\n\s+continue-on-error: true\n\s+run: pnpm shared-preview:cleanup-smoke/,
  );
});

test("shared-preview reset resolves the hosted revision and verifies the whole fleet", () => {
  const workflow = readFileSync(".github/workflows/reset-shared-preview.yml", "utf8");
  assert.match(workflow, /node scripts\/resolve-shared-preview-deployed-sha\.mjs/);
  assert.match(workflow, /SPLITCH_DEPLOYED_COMMIT_SHA=\$deployed_sha/);
  assert.match(
    workflow,
    /SPLITCH_SMOKE_COMMIT_SHA="\$SPLITCH_DEPLOYED_COMMIT_SHA" pnpm shared-preview:smoke/,
  );
  assert.match(workflow, /node scripts\/render-shared-preview-summary\.mjs reset/);
  assert.doesNotMatch(workflow, /Deployed SHA: unavailable\/unverified/);
});

function summary(mode, evidencePath, workflowRef) {
  return spawnSync(process.execPath, ["scripts/render-shared-preview-summary.mjs", mode], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    env: {
      ...process.env,
      SPLITCH_CLEANUP_OUTCOME: "success",
      SPLITCH_DARK_LAUNCH_OUTCOME: "success",
      SPLITCH_ARTIFACT_OUTCOME: "skipped",
      SPLITCH_RESET_OUTCOME: "success",
      SPLITCH_SEED_OUTCOME: "success",
      SPLITCH_SMOKE_EVIDENCE_FILE: evidencePath,
      SPLITCH_SMOKE_OUTCOME: "success",
      SPLITCH_WORKFLOW_REF: workflowRef,
    },
  });
}

function route(surface, service) {
  return { surface, service, url: `https://${service}.example.test/health` };
}

function health(service, deployedCommitSha) {
  return { ok: true, platformTarget: "shared-preview", service, deployedCommitSha };
}

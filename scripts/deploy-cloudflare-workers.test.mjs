import assert from "node:assert/strict";
import test from "node:test";
import { deploymentCommands } from "./deploy-cloudflare-workers.mjs";
import { readWorkspacePackages } from "./lib/production-deploy-plan.mjs";

const workspacePackages = readWorkspacePackages(new URL("..", import.meta.url).pathname);

test("deploys one independent Worker without traversing the fleet", () => {
  assert.deepEqual(deploymentCommands("production", ["@splitch/mcp-server"], workspacePackages), [
    [
      "turbo",
      "run",
      "deploy",
      "--filter=@splitch/mcp-server",
      "--",
      "--env",
      "production",
      "--strict",
    ],
  ]);
});

test("preserves the bounded Control Panel cutover when either side changes", () => {
  for (const changedPackage of ["@splitch/control-panel", "@splitch/control-plane-api"]) {
    assert.deepEqual(deploymentCommands("production", [changedPackage], workspacePackages), [
      ["run", "deploy:cloudflare:control-plane-compat:production"],
      ["run", "deploy:cloudflare:control-panel:production"],
      ["run", "deploy:cloudflare:control-plane:production"],
      ["run", "credential-cache:backfill:production"],
    ]);
  }
});

test("backfills before deploying an affected Evaluation Worker", () => {
  assert.deepEqual(
    deploymentCommands("production", ["@splitch/evaluation-api"], workspacePackages),
    [
      ["run", "credential-cache:backfill:production"],
      [
        "turbo",
        "run",
        "deploy",
        "--filter=@splitch/evaluation-api",
        "--",
        "--env",
        "production",
        "--strict",
      ],
    ],
  );
});

test("deploys Analysis first and independent remaining Workers together", () => {
  assert.deepEqual(
    deploymentCommands(
      "production",
      ["@splitch/mcp-server", "@splitch/analysis-api", "@splitch/auth-api"],
      workspacePackages,
    ),
    [
      ["run", "deploy:cloudflare:analysis:production"],
      [
        "turbo",
        "run",
        "deploy",
        "--filter=@splitch/auth-api",
        "--filter=@splitch/mcp-server",
        "--",
        "--env",
        "production",
        "--strict",
      ],
    ],
  );
});

test("rejects empty and unknown Worker plans", () => {
  assert.throws(() => deploymentCommands("production", [], workspacePackages), /at least one/u);
  assert.throws(
    () => deploymentCommands("production", ["@splitch/not-real"], workspacePackages),
    /unknown deployable/u,
  );
});

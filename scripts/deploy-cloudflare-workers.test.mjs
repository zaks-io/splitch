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
      ["run", "credential-cache:backfill:production"],
      ["run", "deploy:cloudflare:control-plane-compat:production"],
      ["run", "deploy:cloudflare:control-panel:production"],
      ["run", "deploy:cloudflare:control-plane:production"],
    ]);
  }
});

test("backfills before deploying an affected Evaluation Worker", () => {
  assert.deepEqual(
    deploymentCommands("production", ["@splitch/evaluation-api"], workspacePackages),
    [
      ["run", "credential-cache:backfill:production"],
      ["run", "deploy:cloudflare:evaluation:production"],
    ],
  );
});

// Evaluation exports the entrypoint Control Plane binds (ADR-0046), so a release
// touching both must put Evaluation on the wire before Control Plane rebinds it.
test("deploys an affected Evaluation Worker before its Control Plane caller", () => {
  assert.deepEqual(
    deploymentCommands(
      "production",
      ["@splitch/control-plane-api", "@splitch/evaluation-api"],
      workspacePackages,
    ),
    [
      ["run", "credential-cache:backfill:production"],
      ["run", "deploy:cloudflare:evaluation:production"],
      ["run", "deploy:cloudflare:control-plane-compat:production"],
      ["run", "deploy:cloudflare:control-panel:production"],
      ["run", "deploy:cloudflare:control-plane:production"],
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

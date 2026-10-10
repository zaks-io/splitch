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

for (const environment of ["production", "shared-preview"]) {
  test(`${environment} deploys Control Plane alone exactly once`, () => {
    assert.deepEqual(
      deploymentCommands(environment, ["@splitch/control-plane-api"], workspacePackages),
      [["run", `deploy:cloudflare:control-plane:${environment}`]],
    );
  });

  test(`${environment} deploys Control Panel alone without redeploying Control Plane`, () => {
    assert.deepEqual(
      deploymentCommands(environment, ["@splitch/control-panel"], workspacePackages),
      [["run", `deploy:cloudflare:control-panel:${environment}`]],
    );
  });

  test(`${environment} deploys Control Plane before a selected Control Panel`, () => {
    assert.deepEqual(
      deploymentCommands(
        environment,
        ["@splitch/control-panel", "@splitch/control-plane-api"],
        workspacePackages,
      ),
      [
        ["run", `deploy:cloudflare:control-plane:${environment}`],
        ["run", `deploy:cloudflare:control-panel:${environment}`],
      ],
    );
  });

  test(`${environment} deploys Evaluation alone`, () => {
    assert.deepEqual(
      deploymentCommands(environment, ["@splitch/evaluation-api"], workspacePackages),
      [["run", `deploy:cloudflare:evaluation:${environment}`]],
    );
  });

  test(`${environment} deploys Control Plane before and after a selected Evaluation`, () => {
    assert.deepEqual(
      deploymentCommands(
        environment,
        ["@splitch/evaluation-api", "@splitch/control-plane-api"],
        workspacePackages,
      ),
      [
        ["run", `deploy:cloudflare:control-plane:${environment}`],
        ["run", `deploy:cloudflare:evaluation:${environment}`],
        ["run", `deploy:cloudflare:control-plane:${environment}`],
      ],
    );
  });
}

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

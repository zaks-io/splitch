import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { readWorkspacePackages } from "./lib/production-deploy-plan.mjs";

const ANALYSIS = "@splitch/analysis-api";
const CONTROL_PANEL = "@splitch/control-panel";
const CONTROL_PLANE = "@splitch/control-plane-api";
const EVALUATION = "@splitch/evaluation-api";
const SPECIAL_WORKERS = new Set([ANALYSIS, CONTROL_PANEL, CONTROL_PLANE]);

export function deploymentCommands(environment, requestedPackages, workspacePackages) {
  assertEnvironment(environment);
  const deployablePackages = new Set(
    workspacePackages
      .filter((workspacePackage) => workspacePackage.deployable)
      .map(({ name }) => name),
  );
  const selected = new Set(requestedPackages);
  const unknown = [...selected].filter((packageName) => !deployablePackages.has(packageName));
  if (unknown.length > 0) {
    throw new Error(`unknown deployable Worker packages: ${unknown.join(", ")}`);
  }
  if (selected.size === 0) {
    throw new Error("at least one deployable Worker package is required");
  }

  const commands = [];
  if (selected.has(ANALYSIS)) {
    commands.push(["run", `deploy:cloudflare:analysis:${environment}`]);
  }

  const requiresControlPanelCutover = selected.has(CONTROL_PANEL) || selected.has(CONTROL_PLANE);
  if (requiresControlPanelCutover) {
    commands.push(
      ["run", `deploy:cloudflare:control-plane-compat:${environment}`],
      ["run", `deploy:cloudflare:control-panel:${environment}`],
      ["run", `deploy:cloudflare:control-plane:${environment}`],
    );
  }

  if (requiresControlPanelCutover || selected.has(EVALUATION)) {
    commands.push(["run", `credential-cache:backfill:${environment}`]);
  }

  const remaining = [...selected].filter((packageName) => !SPECIAL_WORKERS.has(packageName)).sort();
  if (remaining.length > 0) {
    commands.push([
      "turbo",
      "run",
      "deploy",
      ...remaining.map((packageName) => `--filter=${packageName}`),
      "--",
      "--env",
      environment,
      "--strict",
    ]);
  }

  return commands;
}

function main() {
  const environment = process.argv[2];
  const requestedPackages = (process.argv[3] ?? "")
    .split(",")
    .map((packageName) => packageName.trim())
    .filter(Boolean);
  const workspacePackages = readWorkspacePackages(process.cwd());
  const commands = deploymentCommands(environment, requestedPackages, workspacePackages);
  const commandEnv = {
    ...process.env,
    CLOUDFLARE_ENV: environment,
    SPLITCH_GENERATED_WRANGLER_ENV: environment,
  };

  for (const args of commands) {
    const result = spawnSync("pnpm", args, { env: commandEnv, stdio: "inherit" });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}

function assertEnvironment(environment) {
  if (environment !== "production" && environment !== "shared-preview") {
    throw new Error("environment must be production or shared-preview");
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (error) {
    console.error(
      `deploy-cloudflare-workers: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

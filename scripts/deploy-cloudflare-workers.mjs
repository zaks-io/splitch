import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { readWorkspacePackages } from "./lib/production-deploy-plan.mjs";

const ANALYSIS = "@splitch/analysis-api";
const CONTROL_PANEL = "@splitch/control-panel";
const CONTROL_PLANE = "@splitch/control-plane-api";
const EVALUATION = "@splitch/evaluation-api";

const EVENT_INGEST = "@splitch/event-ingest-api";

/**
 * Providers before consumers, because a Worker's `services` binding is resolved
 * when the *caller* deploys: Control Plane delegates to Analysis and Evaluation
 * over named entrypoints (ADR-0046), and Evaluation writes through Event
 * Ingest. Deploying a caller first binds it to an entrypoint the live callee
 * does not export yet.
 *
 * deploy-worker-order.test.mjs derives the required edges from every app's
 * wrangler.jsonc and proves this order satisfies them, so a new binding fails
 * there rather than mid-cutover in production.
 */
const ORDERED_PREREQUISITES = [
  [EVENT_INGEST, "event-ingest"],
  [ANALYSIS, "analysis"],
];
const SPECIAL_WORKERS = new Set([
  ...ORDERED_PREREQUISITES.map(([packageName]) => packageName),
  EVALUATION,
  CONTROL_PANEL,
  CONTROL_PLANE,
]);

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

  const requiresControlPanelCutover = selected.has(CONTROL_PANEL) || selected.has(CONTROL_PLANE);
  const commands = selectedPrerequisiteCommands(environment, selected, ORDERED_PREREQUISITES);

  // Evaluation binds the Config Store DO while Control Plane binds Evaluation's
  // named entrypoint. When both change, the compatibility deploy supplies the
  // new DO RPC first, Evaluation moves second, and final Control Plane moves last.
  if (requiresControlPanelCutover) {
    commands.push(["run", `deploy:cloudflare:control-plane-compat:${environment}`]);
  }
  if (selected.has(EVALUATION)) {
    commands.push(["run", `deploy:cloudflare:evaluation:${environment}`]);
  }
  if (requiresControlPanelCutover) {
    commands.push(["run", `credential-cache:backfill:${environment}`]);
  }

  if (requiresControlPanelCutover) {
    commands.push(
      ["run", `deploy:cloudflare:control-panel:${environment}`],
      ["run", `deploy:cloudflare:control-plane:${environment}`],
    );
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

function selectedPrerequisiteCommands(environment, selected, prerequisites) {
  return prerequisites
    .filter(([packageName]) => selected.has(packageName))
    .map(([, scriptName]) => ["run", `deploy:cloudflare:${scriptName}:${environment}`]);
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

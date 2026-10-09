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
 * Cross-script Durable Object bindings do not constrain this order and are not
 * part of it: they resolve to a namespace the defining Worker already owns, so
 * Event Ingest can deploy first while binding classes on Evaluation and Control
 * Plane, which both deploy later. Only the first deploy that introduces a brand
 * new class has to land before a Worker binds it.
 *
 * deploy-worker-order.test.mjs derives the required edges from every app's
 * wrangler.jsonc and proves this order satisfies them, so a new binding fails
 * there rather than mid-cutover in production. It separately proves every
 * cross-script Durable Object binding names a class the fleet actually defines.
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

  const commands = selectedPrerequisiteCommands(environment, selected, ORDERED_PREREQUISITES);
  if (selected.has(CONTROL_PLANE)) {
    commands.push(["run", `deploy:cloudflare:control-plane:${environment}`]);
  }
  if (selected.has(EVALUATION)) {
    commands.push(["run", `deploy:cloudflare:evaluation:${environment}`]);
    // Both Workers bind each other's named entrypoint, so Control Plane must
    // deploy before Evaluation and rebind after Evaluation deploys.
    if (selected.has(CONTROL_PLANE)) {
      commands.push(["run", `deploy:cloudflare:control-plane:${environment}`]);
    }
  }
  if (selected.has(CONTROL_PANEL)) {
    commands.push(["run", `deploy:cloudflare:control-panel:${environment}`]);
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

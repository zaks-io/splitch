import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { deploymentCommands } from "./deploy-cloudflare-workers.mjs";
import { readWorkspacePackages } from "./lib/production-deploy-plan.mjs";
import { parseWranglerConfigFile } from "./lib/wrangler-config.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const workspacePackages = readWorkspacePackages(repoRoot);
const deployable = workspacePackages.filter((entry) => entry.deployable).map(({ name }) => name);

/**
 * A `services` binding is resolved when the CALLER deploys, so the callee has to
 * already be live -- and for a named entrypoint (ADR-0046 delegation) it has to
 * already export that entrypoint, or the caller's deploy fails outright.
 *
 * The edges are read out of the wrangler configs rather than restated here, so
 * adding a binding without an ordering entry fails this test instead of failing
 * a production cutover halfway through.
 */
function serviceEdges() {
  const workerToPackage = new Map();
  const bindings = new Map();

  for (const entry of readdirSync(join(repoRoot, "apps"), { withFileTypes: true })) {
    const worker = readWorker(entry);
    if (worker === null) continue;
    // Every env alias of the same Worker maps back to the one package that ships it.
    for (const name of workerNames(worker.config)) workerToPackage.set(name, worker.packageName);
    bindings.set(worker.packageName, collectServices(worker.config));
  }

  return [...bindings].flatMap(([caller, services]) =>
    [...services].flatMap((service) => workerBindingEdge(caller, service, workerToPackage)),
  );
}

function workerBindingEdge(caller, service, workerToPackage) {
  const callee = workerToPackage.get(service);
  return callee && callee !== caller ? [{ caller, callee }] : [];
}

function readWorker(entry) {
  if (!entry.isDirectory()) return null;
  const appRoot = join(repoRoot, "apps", entry.name);
  try {
    return {
      config: parseWranglerConfigFile(join(appRoot, "wrangler.jsonc")),
      packageName: JSON.parse(readFileSync(join(appRoot, "package.json"), "utf8")).name,
    };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function workerNames(config) {
  const names = new Set();
  if (config.name) names.add(config.name);
  for (const target of Object.values(config.env ?? {})) {
    if (target?.name) names.add(target.name);
  }
  return names;
}

function collectServices(config) {
  const found = new Set();
  for (const target of [config, ...Object.values(config.env ?? {})]) {
    for (const binding of target?.services ?? []) {
      if (binding?.service) found.add(binding.service);
    }
  }
  return found;
}

/** The package each emitted command deploys, in the order the command list runs. */
function deployOrder(commands) {
  const order = [];
  for (const args of commands) {
    for (const name of deployable) {
      if (args.some((arg) => arg === `--filter=${name}`)) order.push(name);
    }
    const [verb, script] = args;
    // The ordering steps and the Control Panel cutover run through pnpm scripts,
    // so map those back to the package each one deploys.
    if (verb === "run" && typeof script === "string") order.push(...packagesDeployedBy(script));
  }
  return order;
}

/**
 * Resolves a pnpm script to the packages it deploys, following the one level of
 * indirection the cutover uses: `deploy:cloudflare:control-plane-compat` shells
 * out to a node script that turbo-deploys Control Plane with a temporary config.
 */
function packagesDeployedBy(scriptName) {
  let body = packageScripts()[scriptName] ?? "";
  const delegated = /node (scripts\/[\w-]+\.mjs)/.exec(body);
  if (delegated) {
    try {
      body += readFileSync(join(repoRoot, delegated[1]), "utf8");
    } catch {
      // A script that is not on disk simply contributes no filters.
    }
  }
  return deployable.filter(
    (name) => body.includes(`--filter=${name}`) && !body.includes(`--filter=!${name}`),
  );
}

let cachedScripts;
function packageScripts() {
  cachedScripts ??= JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).scripts;
  return cachedScripts;
}

function fullFleetOrder(environment) {
  const chain = packageScripts()[`deploy:cloudflare:${environment}`].split(" && ");
  const order = [];
  for (const step of chain) {
    const script = step.replace(/^pnpm /, "");
    order.push(...packagesDeployedBy(script));
    if (!script.startsWith("deploy:cloudflare:remaining")) continue;
    const body = packageScripts()[script] ?? "";
    for (const name of deployable) {
      if (!body.includes(`--filter=!${name}`) && !order.includes(name)) order.push(name);
    }
  }
  return order;
}

for (const environment of ["production", "shared-preview"]) {
  test(`${environment} selective deploy orders every service callee before its caller`, () => {
    const order = deployOrder(deploymentCommands(environment, deployable, workspacePackages));

    for (const { caller, callee } of serviceEdges()) {
      const callerAt = order.lastIndexOf(caller);
      const calleeAt = order.indexOf(callee);
      assert.notEqual(calleeAt, -1, `${callee} is bound by ${caller} but never deployed`);
      assert.notEqual(callerAt, -1, `${caller} was never deployed`);
      assert.ok(
        calleeAt < callerAt,
        `${callee} must deploy before ${caller} (it binds ${callee} as a service), got ${order.join(" -> ")}`,
      );
    }
  });

  test(`${environment} full-fleet script orders every service callee before its caller`, () => {
    const order = fullFleetOrder(environment);

    for (const { caller, callee } of serviceEdges()) {
      const callerAt = order.lastIndexOf(caller);
      const calleeAt = order.indexOf(callee);
      assert.ok(
        calleeAt !== -1 && callerAt !== -1 && calleeAt < callerAt,
        `${callee} must deploy before ${caller} in deploy:cloudflare:${environment}, got ${order.join(" -> ")}`,
      );
    }
  });
}

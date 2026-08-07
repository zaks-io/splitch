import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { deploymentCommands } from "./deploy-cloudflare-workers.mjs";
import { parseWranglerConfigFile } from "./lib/wrangler-config.mjs";
import { readWorkspacePackages } from "./lib/production-deploy-plan.mjs";

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
    if (!entry.isDirectory()) continue;
    let config;
    try {
      config = parseWranglerConfigFile(join(repoRoot, "apps", entry.name, "wrangler.jsonc"));
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    const packageName = JSON.parse(
      readFileSync(join(repoRoot, "apps", entry.name, "package.json"), "utf8"),
    ).name;
    // Every env alias of the same Worker maps back to the one package that ships it.
    for (const name of workerNames(config)) workerToPackage.set(name, packageName);
    bindings.set(packageName, collectServices(config));
  }

  const edges = [];
  for (const [caller, services] of bindings) {
    for (const service of services) {
      const callee = workerToPackage.get(service);
      if (callee && callee !== caller) edges.push({ caller, callee });
    }
  }
  return edges;
}

function workerNames(config) {
  const names = new Set();
  if (config.name) names.add(config.name);
  for (const target of Object.values(config.env ?? {})) {
    if (target?.name) names.add(target.name);
  }
  return names;
}

function collectServices(node, found = new Set()) {
  if (Array.isArray(node)) {
    for (const item of node) collectServices(item, found);
    return found;
  }
  if (!node || typeof node !== "object") return found;
  for (const [key, value] of Object.entries(node)) {
    if (key === "services" && Array.isArray(value)) {
      for (const binding of value) if (binding?.service) found.add(binding.service);
    } else {
      collectServices(value, found);
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

for (const environment of ["production", "shared-preview"]) {
  test(`${environment} selective deploy orders every service callee before its caller`, () => {
    const order = deployOrder(deploymentCommands(environment, deployable, workspacePackages));

    for (const { caller, callee } of serviceEdges()) {
      const callerAt = order.indexOf(caller);
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
    const chain = packageScripts()[`deploy:cloudflare:${environment}`].split(" && ");
    const order = [];
    for (const step of chain) {
      const script = step.replace(/^pnpm /, "");
      order.push(...packagesDeployedBy(script));
      // `remaining` is a negated glob: whatever no earlier step deployed lands here.
      if (script.startsWith("deploy:cloudflare:remaining")) {
        const body = packageScripts()[script] ?? "";
        for (const name of deployable) {
          if (!body.includes(`--filter=!${name}`) && !order.includes(name)) order.push(name);
        }
      }
    }

    for (const { caller, callee } of serviceEdges()) {
      const callerAt = order.indexOf(caller);
      const calleeAt = order.indexOf(callee);
      assert.ok(
        calleeAt !== -1 && callerAt !== -1 && calleeAt < callerAt,
        `${callee} must deploy before ${caller} in deploy:cloudflare:${environment}, got ${order.join(" -> ")}`,
      );
    }
  });
}

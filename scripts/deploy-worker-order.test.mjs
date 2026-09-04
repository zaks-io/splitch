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

  for (const worker of workers()) {
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

/**
 * A cross-script Durable Object binding (`script_name` on a `durable_objects`
 * binding) is deliberately NOT collected as an ordering edge. It resolves to a
 * namespace the defining Worker owns, and that namespace exists from the first
 * deploy that declared the class onward -- unlike a `services` binding, which
 * the caller re-resolves against the live callee on every deploy and which
 * fails outright when a named entrypoint is not exported yet. Event Ingest has
 * shipped a binding on Control Plane's `ConfigStoreDurableObject` while
 * deploying first and Control Plane last on the same run.
 *
 * That is also why Event Ingest binding Evaluation's Assignment Store class,
 * while Evaluation binds Event Ingest as a service, is not a deploy cycle: the
 * two edges are resolved at different times and only the `services` one
 * constrains order.
 *
 * What is load-bearing, and invisible to every other check, is that the script
 * and class named exist in the fleet at all -- in the SAME environment as the
 * target that names them. Every Worker here ships one script name per
 * environment, so a shared-preview binding left pointing at the production
 * script deploys clean and then reads production's Durable Objects from
 * preview. The edge therefore carries the env key it was declared under, and
 * `undefined` for the top-level target.
 */
function durableObjectEdges() {
  return workers().flatMap(({ config, packageName }) =>
    namedTargets(config).flatMap(([env, target]) =>
      (target?.durable_objects?.bindings ?? [])
        .filter((binding) => binding?.script_name)
        .map((binding) => ({
          caller: packageName,
          className: binding.class_name,
          env,
          script: binding.script_name,
        })),
    ),
  );
}

/** Each deployable target of a config, paired with the env key that selects it. */
function namedTargets(config) {
  return [[undefined, config], ...Object.entries(config.env ?? {})];
}

/** The script name a config deploys under one env key, or nothing if it has none. */
function targetName(config, env) {
  return env === undefined ? config.name : config.env?.[env]?.name;
}

/** Every Durable Object class a Worker declares, however it declares it. */
function definedClasses(config) {
  const defined = new Set();
  for (const target of targets(config)) {
    for (const migration of target?.migrations ?? []) {
      for (const name of migration?.new_classes ?? []) defined.add(name);
      for (const name of migration?.new_sqlite_classes ?? []) defined.add(name);
      for (const name of migration?.deleted_classes ?? []) defined.delete(name);
    }
    for (const [name, entry] of Object.entries(target?.exports ?? {})) {
      if (entry?.type === "durable-object") defined.add(name);
    }
    for (const binding of target?.durable_objects?.bindings ?? []) {
      if (!binding?.script_name && binding?.class_name) defined.add(binding.class_name);
    }
  }
  return defined;
}

function targets(config) {
  return namedTargets(config).map(([, target]) => target);
}

let cachedWorkers;
function workers() {
  cachedWorkers ??= readdirSync(join(repoRoot, "apps"), { withFileTypes: true })
    .map(readWorker)
    .filter((worker) => worker !== null);
  return cachedWorkers;
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

test("every cross-script Durable Object binding names a class its Worker defines there", () => {
  const edges = durableObjectEdges();

  assert.ok(edges.length > 0, "no cross-script Durable Object bindings were found to check");
  for (const { caller, className, env, script } of edges) {
    const where = env ? `its "${env}" environment` : "its top-level target";
    const definer = workers().find((worker) => targetName(worker.config, env) === script);
    assert.ok(
      definer,
      `${caller} binds ${className} on "${script}" in ${where}, which no Worker in apps/ ships under that environment`,
    );
    assert.ok(
      definedClasses(definer.config).has(className),
      `${caller} binds ${className} on "${script}" in ${where}, which declares no such Durable Object class`,
    );
  }
});

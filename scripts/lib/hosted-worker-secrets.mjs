import { readdirSync } from "node:fs";
import { join } from "node:path";
import { parseWranglerConfigFile } from "./wrangler-config.mjs";

const HOSTED_ENVS = ["shared-preview", "production"];

export const MCP_DELEGATION_PAIRS = [
  {
    name: "MCP_CONTROL_PLANE_DELEGATION_SECRET",
    apps: ["mcp-server", "control-plane-api"],
  },
  {
    name: "MCP_EVALUATION_DELEGATION_SECRET",
    apps: ["mcp-server", "evaluation-api"],
  },
  {
    name: "MCP_ANALYSIS_DELEGATION_SECRET",
    apps: ["mcp-server", "analysis-api"],
  },
];

/** Returns the union Wrangler requires across every hosted Worker target. */
export function hostedWorkerSecretUnion(rootDir) {
  const names = new Set();
  for (const envName of HOSTED_ENVS) {
    for (const name of hostedWorkerSecrets(rootDir, envName).keys()) names.add(name);
  }
  return [...names].sort();
}

/** Returns required secret names mapped to the Worker app directories that consume them. */
export function hostedWorkerSecrets(rootDir, envName) {
  if (!HOSTED_ENVS.includes(envName)) throw new Error(`unsupported hosted environment: ${envName}`);
  const consumers = new Map();

  for (const [appName, config] of workerConfigs(rootDir)) {
    const required = config.env?.[envName]?.secrets?.required ?? config.secrets?.required ?? [];
    for (const name of new Set(required)) {
      const apps = consumers.get(name) ?? [];
      apps.push(appName);
      consumers.set(name, apps);
    }
  }

  return new Map([...consumers].sort(([left], [right]) => left.localeCompare(right)));
}

export function assertHostedDelegationSecretConfig(rootDir, envName) {
  const consumers = hostedWorkerSecrets(rootDir, envName);
  const expectedNames = new Set(MCP_DELEGATION_PAIRS.map(({ name }) => name));

  for (const { name, apps } of MCP_DELEGATION_PAIRS) {
    const actual = [...(consumers.get(name) ?? [])].sort();
    const expected = [...apps].sort();
    if (actual.join("\0") !== expected.join("\0")) {
      throw new Error(
        `${envName}:${name} must be required by exactly ${expected.join(", ")}; found ${actual.join(", ") || "none"}`,
      );
    }
  }

  for (const name of consumers.keys()) {
    if (
      name.startsWith("MCP_") &&
      name.endsWith("_DELEGATION_SECRET") &&
      !expectedNames.has(name)
    ) {
      throw new Error(`${envName}:unexpected MCP delegation secret name ${name}`);
    }
  }
}

export function validateHostedWorkerSecretEnv(rootDir, envName, env) {
  assertHostedDelegationSecretConfig(rootDir, envName);
  const required = [...hostedWorkerSecrets(rootDir, envName).keys()];
  const missing = required.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(`missing required Worker secret env: ${missing.join(", ")}`);
  }

  const delegationValues = MCP_DELEGATION_PAIRS.map(({ name }) => env[name]);
  if (new Set(delegationValues).size !== delegationValues.length) {
    throw new Error("MCP delegation secrets must be distinct across downstream services");
  }
  return required;
}

function workerConfigs(rootDir) {
  const configs = [];
  const appsDir = join(rootDir, "apps");
  for (const entry of readdirSync(appsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const configPath = join(appsDir, entry.name, "wrangler.jsonc");
    try {
      configs.push([entry.name, parseWranglerConfigFile(configPath)]);
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") continue;
      throw error;
    }
  }
  return configs;
}

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { parseWranglerConfigFile } from "./wrangler-config.mjs";

const HOSTED_ENVS = ["shared-preview", "production"];

/** Returns the union Wrangler requires across every hosted Worker target. */
export function hostedWorkerSecretUnion(rootDir) {
  const names = new Set();
  const appsDir = join(rootDir, "apps");

  for (const entry of readdirSync(appsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const configPath = join(appsDir, entry.name, "wrangler.jsonc");
    let config;
    try {
      config = parseWranglerConfigFile(configPath);
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") continue;
      throw error;
    }
    for (const envName of HOSTED_ENVS) {
      const required = config.env?.[envName]?.secrets?.required ?? config.secrets?.required ?? [];
      for (const name of required) names.add(name);
    }
  }

  return [...names].sort();
}

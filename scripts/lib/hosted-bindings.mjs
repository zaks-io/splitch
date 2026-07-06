const HOSTED_WRANGLER_ENVS = new Set(["production", "shared-preview"]);
export const PLACEHOLDER_KV_ID = "00000000000000000000000000000000";
const PLACEHOLDER_D1_ID = "00000000-0000-0000-0000-000000000000";

export function isHostedWranglerEnv(envName) {
  return HOSTED_WRANGLER_ENVS.has(envName);
}

export function requireHostedWranglerEnvTarget(config, envName, source) {
  if (!isHostedWranglerEnv(envName)) {
    return undefined;
  }

  const target = config?.env?.[envName];
  if (!target) {
    throw new Error(`${source} must declare env.${envName} for hosted deploy`);
  }
  return target;
}

export function assertNoPlaceholderHostedBindings(config, source) {
  const issues = [
    ...invalidKvBindings(config?.kv_namespaces),
    ...invalidD1Bindings(config?.d1_databases),
  ];

  if (issues.length > 0) {
    throw new Error(
      `${source} has placeholder or missing Cloudflare binding IDs: ${issues.join(", ")}`,
    );
  }
}

function invalidKvBindings(namespaces) {
  if (!Array.isArray(namespaces)) {
    return [];
  }

  return namespaces.flatMap((namespace) => {
    const binding = resourceName(namespace?.binding);
    const id = namespace?.id;
    return typeof id === "string" && id !== "" && id !== PLACEHOLDER_KV_ID
      ? []
      : [`kv_namespaces.${binding}.id`];
  });
}

function invalidD1Bindings(databases) {
  if (!Array.isArray(databases)) {
    return [];
  }

  return databases.flatMap((database) => {
    const binding = resourceName(database?.binding);
    const id = database?.database_id;
    return typeof id === "string" && id !== "" && id !== PLACEHOLDER_D1_ID
      ? []
      : [`d1_databases.${binding}.database_id`];
  });
}

function resourceName(value) {
  return typeof value === "string" && value.length > 0 ? value : "<unknown>";
}

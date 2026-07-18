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

export function assertHostedAuthOrigins(config, source) {
  if (config?.name !== "splitch-auth-api") {
    return;
  }

  const origin = config?.vars?.CONTROL_PANEL_ORIGIN;
  if (typeof origin !== "string" || origin.length === 0) {
    throw new Error(`${source} must declare vars.CONTROL_PANEL_ORIGIN for hosted claims`);
  }

  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error(`${source}.vars.CONTROL_PANEL_ORIGIN must be an absolute URL`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error(
      `${source}.vars.CONTROL_PANEL_ORIGIN must be an https origin without a path for hosted claims`,
    );
  }
}

export function assertHostedAuthVerifierBindings(config, source) {
  if (config?.name !== "splitch-auth-api") {
    return;
  }
  const required = config?.secrets?.required;
  const missing = ["WORKOS_JWKS_URI", "WORKOS_ISSUER", "WORKOS_CLIENT_ID"].filter(
    (name) => !Array.isArray(required) || !required.includes(name),
  );
  if (missing.length > 0) {
    throw new Error(
      `${source} must require hosted WorkOS verifier bindings: ${missing.join(", ")}`,
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

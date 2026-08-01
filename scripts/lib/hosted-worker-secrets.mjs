import { createPrivateKey } from "node:crypto";
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

export async function validateHostedWorkerSecretEnv(rootDir, envName, env, deps = {}) {
  assertHostedDelegationSecretConfig(rootDir, envName);
  const consumers = hostedWorkerSecrets(rootDir, envName);
  const required = [...consumers.keys()];
  const missing = required.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(`missing required Worker secret env: ${missing.join(", ")}`);
  }

  const delegationValues = MCP_DELEGATION_PAIRS.map(({ name }) => env[name]);
  if (new Set(delegationValues).size !== delegationValues.length) {
    throw new Error("MCP delegation secrets must be distinct across downstream services");
  }

  if (required.includes("ACCESS_TOKEN_SECRET")) {
    assertRsaPrivateJwkSecret("ACCESS_TOKEN_SECRET", env.ACCESS_TOKEN_SECRET);
  }
  if (required.includes(TINYBIRD_INGEST_TOKEN)) {
    await assertTinybirdIngestToken(
      rootDir,
      envName,
      consumers,
      env,
      deps.fetch ?? globalThis.fetch,
    );
  }
  return required;
}

const TINYBIRD_INGEST_TOKEN = "TINYBIRD_INGEST_TOKEN";
/** Every Data Source the ingest Worker appends to; see apps/event-ingest-api/src/tinybird.ts. */
const TINYBIRD_INGEST_DATASOURCES = ["raw_events", "raw_evaluations"];

/**
 * Presence proved nothing here. A wrong, expired, or under-scoped ingest token
 * deploys clean and then loses every Exposure at runtime, with the loss visible
 * only in the ingest Worker's logs. So make the deploy exercise the exact call
 * the Worker makes -- an append to each ingest Data Source -- and fail before
 * the Worker is replaced. The body carries zero rows, so the probe writes
 * nothing and is safe to repeat on every deploy.
 */
async function assertTinybirdIngestToken(rootDir, envName, consumers, env, fetchImpl) {
  const apiUrl = tinybirdApiUrl(rootDir, envName, consumers);
  for (const datasource of TINYBIRD_INGEST_DATASOURCES) {
    const url = new URL("/v0/events", apiUrl);
    url.searchParams.set("name", datasource);

    let response;
    try {
      response = await fetchImpl(url.toString(), {
        method: "POST",
        headers: {
          authorization: `Bearer ${env[TINYBIRD_INGEST_TOKEN]}`,
          "content-type": "application/x-ndjson",
        },
        body: "",
      });
    } catch (cause) {
      throw new Error(
        `${TINYBIRD_INGEST_TOKEN} could not be exercised against ${url.host}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }

    // 401/403 is a rejected credential; 404 is the right credential pointed at a
    // Workspace or region without this Data Source. Tinybird's error body can
    // quote the token, so it is deliberately not forwarded.
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      throw new Error(
        `${TINYBIRD_INGEST_TOKEN} was rejected by ${url.host} for Data Source "${datasource}" (HTTP ${response.status}); it must carry APPEND scope on ${TINYBIRD_INGEST_DATASOURCES.join(" and ")} in that region`,
      );
    }
  }
}

function tinybirdApiUrl(rootDir, envName, consumers) {
  const [appName] = consumers.get(TINYBIRD_INGEST_TOKEN) ?? [];
  const config = parseWranglerConfigFile(join(rootDir, "apps", appName, "wrangler.jsonc"));
  const apiUrl = config.env?.[envName]?.vars?.TINYBIRD_API_URL ?? config.vars?.TINYBIRD_API_URL;
  if (!apiUrl) {
    throw new Error(
      `${appName} ${envName} requires ${TINYBIRD_INGEST_TOKEN} but declares no TINYBIRD_API_URL var to exercise it against`,
    );
  }
  return apiUrl;
}

/**
 * Hosted auth signs access tokens RS256 and publishes the public half at
 * /.well-known/jwks.json, so this secret is a key, not a passphrase. Presence
 * alone let a leftover HMAC string reach production: the Worker booted, reported
 * healthy, and threw on every mint. Loading the key here fails the deploy before
 * the Worker is replaced. The value never appears in the error.
 */
function assertRsaPrivateJwkSecret(name, value) {
  let jwk;
  try {
    jwk = JSON.parse(value);
  } catch {
    throw new Error(`${name} must be an exported RSA private JWK (JSON), not an opaque string`);
  }
  try {
    createPrivateKey({ key: jwk, format: "jwk" });
  } catch {
    // The underlying error names the offending JWK field and can quote its
    // value, so it is deliberately not forwarded.
    throw new Error(
      `${name} is not a loadable RSA private key; export the full private JWK including its CRT parameters (p, q, dp, dq, qi)`,
    );
  }
  if (jwk.kty !== "RSA") {
    throw new Error(`${name} must be an RSA private JWK; found kty "${jwk.kty}"`);
  }
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

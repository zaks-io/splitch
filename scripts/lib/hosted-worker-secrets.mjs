import { createPrivateKey } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
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
  for (const append of TINYBIRD_APPEND_TOKENS) {
    if (required.includes(append.envName)) {
      await assertTinybirdAppendToken(
        rootDir,
        envName,
        consumers,
        env,
        deps.fetch ?? globalThis.fetch,
        append,
      );
    }
  }
  return required;
}

/**
 * Every Tinybird APPEND credential a Worker deploys with, keyed to the token
 * scope its `.datasource` files declare. Which Data Sources each token must
 * reach is still read from the Tinybird project, so a new Data Source under an
 * existing token is probed with no edit here; only a new token NAME adds a row.
 * `loss` names what a wrong-but-present token silently costs at runtime.
 */
const TINYBIRD_APPEND_TOKENS = [
  {
    envName: "TINYBIRD_INGEST_TOKEN",
    scope: "TOKEN raw_events_ingest APPEND",
    loss: "drops Exposures silently",
  },
  {
    envName: "TINYBIRD_RUN_SNAPSHOT_TOKEN",
    scope: "TOKEN run_snapshots_ingest APPEND",
    loss: "leaves every hosted Run invisible to analysis",
  },
];
/** A hung Tinybird must not hang the deploy; the probe writes nothing, so retry is free. */
const TINYBIRD_PROBE_TIMEOUT_MS = 10_000;

/**
 * The Data Sources this token must reach, read from the Tinybird project rather
 * than restated here: the `.datasource` files already declare which token appends
 * to them, so a new ingest Data Source is probed without a second list to update.
 */
function tinybirdAppendDatasources(rootDir, append) {
  const dir = join(rootDir, "infra", "tinybird", "datasources");
  const names = readdirSync(dir)
    .filter((file) => file.endsWith(".datasource"))
    .filter((file) => readFileSync(join(dir, file), "utf8").includes(append.scope))
    .map((file) => file.replace(/\.datasource$/, ""))
    .sort();
  if (names.length === 0) {
    throw new Error(
      `no Data Source in ${dir} declares "${append.scope}", so ${append.envName} cannot be exercised`,
    );
  }
  return names;
}

/**
 * Presence proved nothing here. A wrong, expired, or under-scoped ingest token
 * deploys clean and then loses every Exposure at runtime, with the loss visible
 * only in the ingest Worker's logs. So make the deploy exercise the exact call
 * the Worker makes -- an append to each ingest Data Source -- and fail before
 * the Worker is replaced. The body carries zero rows, so the probe writes
 * nothing and is safe to repeat on every deploy.
 */
async function assertTinybirdAppendToken(rootDir, envName, consumers, env, fetchImpl, append) {
  const apiUrl = tinybirdApiUrl(rootDir, envName, consumers, append);
  const datasources = tinybirdAppendDatasources(rootDir, append);
  for (const datasource of datasources) {
    const url = new URL("/v0/events", apiUrl);
    url.searchParams.set("name", datasource);

    let response;
    try {
      response = await fetchImpl(url.toString(), {
        method: "POST",
        headers: {
          authorization: `Bearer ${env[append.envName]}`,
          "content-type": "application/x-ndjson",
        },
        body: "",
        signal: AbortSignal.timeout(TINYBIRD_PROBE_TIMEOUT_MS),
      });
    } catch (cause) {
      // Same rule as the response path below: this request carries the token in
      // an Authorization header, so nothing free-text from the failure is
      // forwarded. The error's class name is a fixed runtime vocabulary
      // (TimeoutError, TypeError) and separates "Tinybird was slow" from
      // "Tinybird was unreachable", which is the whole diagnostic need.
      throw new Error(
        `${append.envName} could not be exercised against ${url.host} (${cause instanceof Error ? cause.name : "unknown error"}); deploying an unverified token ${append.loss}`,
      );
    }

    assertTinybirdProbeResponse(response, datasource, url.host, datasources, append);
  }
}

/**
 * Tinybird's error body can quote the token, so no response text is forwarded --
 * only the status and what it means for the deploy.
 *
 * A 5xx proves nothing about the credential, and the whole point of this probe is
 * that an unproven ingest token silently drops every Exposure once it ships. So an
 * unreachable Tinybird blocks the deploy rather than waving it through.
 *
 * Other statuses pass: the exact success shape of a zero-row append is Tinybird's
 * to define, and asserting a specific 2xx here would fail deploys on a credential
 * that works.
 */
function assertTinybirdProbeResponse(response, datasource, host, datasources, append) {
  // 401/403 is a rejected credential; 404 is the right credential pointed at a
  // Workspace or region without this Data Source.
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    throw new Error(
      `${append.envName} was rejected by ${host} for Data Source "${datasource}" (HTTP ${response.status}); it must carry APPEND scope on ${datasources.join(" and ")} in that region`,
    );
  }
  if (response.status >= 500) {
    throw new Error(
      `${append.envName} could not be verified against ${host} for Data Source "${datasource}" (HTTP ${response.status}); deploying an unverified token ${append.loss}`,
    );
  }
}

function tinybirdApiUrl(rootDir, envName, consumers, append) {
  const [appName] = consumers.get(append.envName) ?? [];
  const config = parseWranglerConfigFile(join(rootDir, "apps", appName, "wrangler.jsonc"));
  const apiUrl = config.env?.[envName]?.vars?.TINYBIRD_API_URL ?? config.vars?.TINYBIRD_API_URL;
  if (!apiUrl) {
    throw new Error(
      `${appName} ${envName} requires ${append.envName} but declares no TINYBIRD_API_URL var to exercise it against`,
    );
  }
  return apiUrl;
}

/** The other key types a JWK can declare, so a wrong one can be named without
 * echoing any part of the parsed secret back into an error message. */
const NON_RSA_KEY_TYPES = ["EC", "OKP", "oct"];

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
    // Naming the type that was exported is the whole diagnostic ("that's the
    // signing key, not the token key"). It is reported by matching against the
    // fixed list above rather than by interpolating the parsed value, so no
    // field of the secret can reach the error text by any path.
    const found = NON_RSA_KEY_TYPES.find((kty) => kty === jwk.kty);
    throw new Error(
      `${name} must be an RSA private JWK; found ${found ? `kty "${found}"` : "a non-RSA key type"}`,
    );
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

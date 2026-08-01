import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  MCP_DELEGATION_PAIRS,
  assertHostedDelegationSecretConfig,
  hostedWorkerSecrets,
  validateHostedWorkerSecretEnv,
} from "./lib/hosted-worker-secrets.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

for (const [envName, workflowPath] of [
  ["shared-preview", ".github/workflows/deploy-shared-preview.yml"],
  ["production", ".github/workflows/deploy-production.yml"],
]) {
  test(`${envName} workflow wires and validates every required Worker secret`, () => {
    assertHostedDelegationSecretConfig(repoRoot, envName);
    const required = [...hostedWorkerSecrets(repoRoot, envName).keys()];
    const workflow = readFileSync(join(repoRoot, workflowPath), "utf8");

    assertWorkflowContract(workflow, envName, required);
  });
}

test("delegation config rejects a missing or mismatched MCP/downstream pair", () => {
  const missing = delegationFixture({ controlPlaneSecret: null });
  assert.throws(
    () => assertHostedDelegationSecretConfig(missing, "production"),
    /MCP_CONTROL_PLANE_DELEGATION_SECRET.*found mcp-server/,
  );

  const mismatched = delegationFixture({
    controlPlaneSecret: "MCP_CONTROL_PLANE_DELEGATION_SECRET_V2",
  });
  assert.throws(
    () => assertHostedDelegationSecretConfig(mismatched, "production"),
    /MCP_CONTROL_PLANE_DELEGATION_SECRET.*found mcp-server/,
  );
});

test("hosted secret validation rejects missing and cross-service reused values", async () => {
  const root = delegationFixture();
  const values = delegationValues();

  await assert.rejects(
    () =>
      validateHostedWorkerSecretEnv(root, "production", {
        ...values,
        MCP_ANALYSIS_DELEGATION_SECRET: "",
      }),
    /missing required Worker secret env: MCP_ANALYSIS_DELEGATION_SECRET/,
  );
  await assert.rejects(
    () =>
      validateHostedWorkerSecretEnv(root, "production", {
        ...values,
        MCP_EVALUATION_DELEGATION_SECRET: values.MCP_CONTROL_PLANE_DELEGATION_SECRET,
      }),
    /must be distinct across downstream services/,
  );
});

test("hosted secret validation rejects an ACCESS_TOKEN_SECRET that cannot sign", async () => {
  const root = delegationFixture();
  writeWorker(root, "auth-api", ["ACCESS_TOKEN_SECRET"]);
  const validate = (accessTokenSecret) =>
    validateHostedWorkerSecretEnv(root, "production", {
      ...delegationValues(),
      ACCESS_TOKEN_SECRET: accessTokenSecret,
    });

  // The shape production actually shipped: an opaque passphrase where an RS256
  // signing key belongs. It booted healthy and threw on every mint.
  await assert.rejects(
    () => validate("leftover-hmac-secret"),
    /must be an exported RSA private JWK/,
  );

  const { kty, n, e, d } = rsaPrivateJwk();
  await assert.rejects(
    () => validate(JSON.stringify({ kty, n, e, d })),
    /not a loadable RSA private key.*CRT parameters/s,
  );
  await assert.rejects(
    () => validate(JSON.stringify(ed25519PrivateJwk())),
    /must be an RSA private JWK; found kty "OKP"/,
  );

  assert.deepEqual(await validate(JSON.stringify(rsaPrivateJwk())), [
    "ACCESS_TOKEN_SECRET",
    ...MCP_DELEGATION_PAIRS.map(({ name }) => name).sort(),
  ]);
});

test("hosted secret validation exercises TINYBIRD_INGEST_TOKEN instead of trusting its presence", async () => {
  const root = delegationFixture();
  writeWorker(root, "event-ingest-api", ["TINYBIRD_INGEST_TOKEN"], {
    TINYBIRD_API_URL: "https://api.us-west-2.aws.tinybird.co",
  });
  const validate = (fetchImpl) =>
    validateHostedWorkerSecretEnv(
      root,
      "production",
      { ...delegationValues(), TINYBIRD_INGEST_TOKEN: "p.not-a-real-token" },
      { fetch: fetchImpl },
    );

  const calls = [];
  const recording = (status) => (url, init) => {
    calls.push({ url, ...init });
    return Promise.resolve(new Response(null, { status }));
  };

  // A non-empty token that Tinybird refuses is exactly what shipped: the deploy
  // was green and every Exposure was dropped at runtime.
  await assert.rejects(
    () => validate(recording(403)),
    /TINYBIRD_INGEST_TOKEN was rejected by api\.us-west-2\.aws\.tinybird\.co for Data Source "raw_evaluations" \(HTTP 403\)/,
  );
  // A right token in the wrong region reaches the API and 404s on the Data Source.
  await assert.rejects(() => validate(recording(404)), /\(HTTP 404\)/);
  await assert.rejects(
    () => validate(() => Promise.reject(new Error("getaddrinfo ENOTFOUND"))),
    /could not be exercised against api\.us-west-2\.aws\.tinybird\.co: getaddrinfo ENOTFOUND/,
  );
  // A 5xx says nothing about the credential. Passing it through would ship the
  // exact unverified token this probe exists to catch.
  await assert.rejects(
    () => validate(recording(503)),
    /could not be verified against api\.us-west-2\.aws\.tinybird\.co for Data Source "raw_evaluations" \(HTTP 503\); deploying an unverified ingest token drops Exposures silently/,
  );

  calls.length = 0;
  assert.deepEqual(await validate(recording(202)), [
    ...MCP_DELEGATION_PAIRS.map(({ name }) => name).sort(),
    "TINYBIRD_INGEST_TOKEN",
  ]);
  // Every Data Source the Worker appends to, probed with zero rows so the check
  // writes nothing. One scoped only to raw_events must not pass.
  assert.deepEqual(
    calls.map(({ url }) => url),
    [
      "https://api.us-west-2.aws.tinybird.co/v0/events?name=raw_evaluations",
      "https://api.us-west-2.aws.tinybird.co/v0/events?name=raw_events",
    ],
  );
  assert.deepEqual(
    calls.map(({ body }) => body),
    ["", ""],
  );
  assert.equal(calls[0].headers.authorization, "Bearer p.not-a-real-token");
});

test("the ingest probe covers every Data Source the token is scoped to, with no second list", async () => {
  const root = delegationFixture();
  writeIngestDatasources(root, ["raw_events", "raw_evaluations", "raw_conversions"]);
  writeWorker(root, "event-ingest-api", ["TINYBIRD_INGEST_TOKEN"], {
    TINYBIRD_API_URL: "https://api.us-west-2.aws.tinybird.co",
  });

  const probed = [];
  await validateHostedWorkerSecretEnv(
    root,
    "production",
    { ...delegationValues(), TINYBIRD_INGEST_TOKEN: "p.not-a-real-token" },
    {
      fetch: (url) => {
        probed.push(new URL(url).searchParams.get("name"));
        return Promise.resolve(new Response(null, { status: 202 }));
      },
    },
  );

  // A Data Source added to the Tinybird project is probed on the next deploy
  // without editing the deploy script, which is the only way the two stay honest.
  assert.deepEqual(probed, ["raw_conversions", "raw_evaluations", "raw_events"]);
});

test("hosted secret validation fails loud when the ingest Worker declares no Tinybird API URL", async () => {
  const root = delegationFixture();
  writeWorker(root, "event-ingest-api", ["TINYBIRD_INGEST_TOKEN"]);

  await assert.rejects(
    () =>
      validateHostedWorkerSecretEnv(
        root,
        "production",
        { ...delegationValues(), TINYBIRD_INGEST_TOKEN: "p.not-a-real-token" },
        { fetch: () => assert.fail("must not probe without a resolved API URL") },
      ),
    /event-ingest-api production requires TINYBIRD_INGEST_TOKEN but declares no TINYBIRD_API_URL/,
  );
});

test("workflow contract rejects an unmapped or unvalidated required secret", () => {
  const workflow = readFileSync(
    join(repoRoot, ".github/workflows/deploy-shared-preview.yml"),
    "utf8",
  );
  const required = [...hostedWorkerSecrets(repoRoot, "shared-preview").keys()];

  assert.throws(
    () =>
      assertWorkflowContract(
        workflow.replace(/^      MCP_ANALYSIS_DELEGATION_SECRET:.*\n/m, ""),
        "shared-preview",
        required,
      ),
    /must map MCP_ANALYSIS_DELEGATION_SECRET/,
  );
  assert.throws(
    () =>
      assertWorkflowContract(
        workflow.replace(
          "node scripts/validate-hosted-worker-secret-env.mjs shared-preview",
          "true",
        ),
        "shared-preview",
        required,
      ),
    /must validate all hosted Worker secrets/,
  );
});

function assertWorkflowContract(workflow, envName, required) {
  assert.match(workflow, /^  SPLITCH_REQUIRE_WORKER_SECRET_ENV: "1"$/m);
  const jobEnv = deployJobEnv(workflow);
  for (const name of required) {
    const value = jobEnv.get(name);
    assert.ok(
      value?.includes(`secrets.${name}`) || value?.includes(`vars.${name}`),
      `${envName} workflow must map ${name} from a same-named environment value`,
    );
  }
  for (const { name } of MCP_DELEGATION_PAIRS) {
    assert.equal(
      jobEnv.get(name),
      `\${{ secrets.${name} }}`,
      `${envName} workflow must map ${name} from the same-named environment secret`,
    );
  }
  assert.match(
    workflow,
    new RegExp(`node scripts/validate-hosted-worker-secret-env\\.mjs ${envName}`),
    `${envName} workflow must validate all hosted Worker secrets`,
  );
}

function deployJobEnv(workflow) {
  const lines = workflow.split("\n");
  const deployStart = lines.findIndex((line) => line === "  deploy:");
  assert.notEqual(deployStart, -1, "workflow must have a deploy job");
  const envStart = lines.findIndex((line, index) => index > deployStart && line === "    env:");
  assert.notEqual(envStart, -1, "deploy job must have an env block");

  const values = new Map();
  for (const line of lines.slice(envStart + 1)) {
    if (/^    \S/.test(line)) break;
    const match = /^      ([A-Z][A-Z0-9_]+):\s*(.+)$/.exec(line);
    if (match) values.set(match[1], match[2]);
  }
  return values;
}

function delegationFixture({ controlPlaneSecret = "MCP_CONTROL_PLANE_DELEGATION_SECRET" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "splitch-delegation-contract-"));
  writeWorker(
    root,
    "mcp-server",
    MCP_DELEGATION_PAIRS.map(({ name }) => name),
  );
  writeWorker(root, "control-plane-api", controlPlaneSecret ? [controlPlaneSecret] : []);
  writeWorker(root, "evaluation-api", ["MCP_EVALUATION_DELEGATION_SECRET"]);
  writeWorker(root, "analysis-api", ["MCP_ANALYSIS_DELEGATION_SECRET"]);
  writeIngestDatasources(root, ["raw_events", "raw_evaluations"]);
  return root;
}

/**
 * The probe reads which Data Sources the ingest token appends to out of the
 * Tinybird project, so the fixture ships the same declaration the real
 * `.datasource` files carry. `deduped_exposures` is written by a Pipe, not by the
 * token, and must stay out of the probe.
 */
function writeIngestDatasources(root, names) {
  const dir = join(root, "infra", "tinybird", "datasources");
  mkdirSync(dir, { recursive: true });
  for (const name of names) {
    writeFileSync(join(dir, `${name}.datasource`), "TOKEN raw_events_ingest APPEND\n");
  }
  writeFileSync(join(dir, "deduped_exposures.datasource"), "TOKEN analysis_read READ\n");
}

let cachedRsaJwk;
/** Generated once: a 2048-bit keygen per assertion dominates this file's runtime. */
function rsaPrivateJwk() {
  cachedRsaJwk ??= generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
    format: "jwk",
  });
  return cachedRsaJwk;
}

function ed25519PrivateJwk() {
  return generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
}

function delegationValues() {
  return Object.fromEntries(
    MCP_DELEGATION_PAIRS.map(({ name }, index) => [name, `delegation-${index}`]),
  );
}

function writeWorker(root, name, required, vars) {
  const appDir = join(root, "apps", name);
  mkdirSync(appDir, { recursive: true });
  const env = { secrets: { required }, ...(vars ? { vars } : {}) };
  writeFileSync(
    join(appDir, "wrangler.jsonc"),
    JSON.stringify({ env: { "shared-preview": env, production: env } }),
  );
}

import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  MCP_DELEGATION_PAIRS,
  assertHostedDelegationSecretConfig,
  hostedWorkerSecrets,
  validateHostedWorkerSecretEnv,
} from "./lib/hosted-worker-secrets.mjs";
import {
  delegationFixture,
  delegationValues,
  writeWorker,
} from "./lib/hosted-worker-secret-test-fixtures.mjs";

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

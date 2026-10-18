#!/usr/bin/env node
import { access, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import {
  check,
  createLocalPatFixture,
  createPatClient,
  FixtureError,
  repoRoot,
  requireSafeOutput,
  writeLocalEvidence,
} from "./cli-pat-local-fixture.mjs";
import { checkTemporaryPermissionRefusals } from "./temporary-environment-permission-checks.mjs";
import {
  assertTemporaryKey,
  callTemporaryMcp,
  publishTemporarySources,
} from "./temporary-environments-e2e-client.mjs";

// Prerequisite: a fresh CLI build. Only issuer/Tinybird are synthetic; all six
// API Workers, D1, KV, Durable Objects, auth, CLI and MCP execute their real code.
const appId = "app_checkout_e2e";
const sourceEnvironment = "env_checkout_prod_e2e";
const flag = "temporary-e2e-flag";
const abort = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => abort.abort());
const passed = [];
let fleet, client, pat, setupPat, failure, workSignal;
let sequence = 0;
let stage = "prerequisites";
const pass = (message) => {
  passed.push(message);
  console.log(`PASS ${message}`);
};
const cli = (args) => client.cli(pat.secret, [...args, "--app", appId]);
const keysFor = async (environment) => [
  environment.clientKey?.keyMaterial,
  await client.apiKey(pat.secret, appId, environment.id),
];

const createTemporary = (key, expiresAt) =>
  cli([
    "envs",
    "create",
    "--key",
    key,
    "--temporary",
    "--from",
    "prod",
    ...(expiresAt ? ["--expires-at", expiresAt] : []),
  ]);

async function assertKeys(keys, expected, expiresAt) {
  await Promise.all(keys.map((key) => assertKey(key, expected, expiresAt)));
}

const mcpState = { sequence: 0 };
const mcp = (name, args, expectedCode) =>
  callTemporaryMcp(
    { fleet, secret: pat.secret, workSignal, appId, state: mcpState },
    name,
    args,
    expectedCode,
  );
const assertKey = (key, expected, expiresAt) =>
  assertTemporaryKey({ fleet, flag, workSignal, sequence: ++sequence }, key, expected, expiresAt);

async function lifecycle() {
  stage = "source Flag publication";
  await publishTemporarySources(cli, flag);
  const source = await cli(["flag-config", "get", flag, "--env", "prod"]);
  const sourceClient = await cli(["client-key", "get", "--env", "prod"]);
  const sourceKeys = [
    sourceClient.keyMaterial,
    await client.apiKey(pat.secret, appId, sourceEnvironment),
  ];
  const assertSource = async () => {
    await assertKeys(sourceKeys, true);
    check(
      isDeepStrictEqual(source, await cli(["flag-config", "get", flag, "--env", "prod"])),
      "Temporary operation changed the source Configuration",
    );
  };
  await assertKeys(sourceKeys, true);
  pass("source Configuration published through real ConfigStore and readable with both keys");

  setupPat = pat;
  pat = await client.mint([
    { target: `app:${appId}`, role: "owner", permissions: ["temporary_environments"] },
  ]);
  const context = await cli(["context"]);
  check(
    context.personalAccessToken?.effective.permissions.temporary_environments.scopes.includes(
      `app:${appId}:owner`,
    ),
    "CLI context missed temporary permission",
  );
  pass("CLI context reports the temporary-only token's live authority");
  stage = "CLI Temporary Environment create";
  const created = await createTemporary("pr-cli-e2e");
  check(
    created.temporary?.syncedFromEnvironmentId === sourceEnvironment,
    "CLI create missed source metadata",
  );
  const keys = await keysFor(created);
  await assertKeys(keys, true);
  pass("built CLI --temporary --from prod; auto Client Key and private API Key observe the copy");

  stage = "temporary Flag flip and source isolation";
  await cli(["flag-config", "update", flag, "--env", "pr-cli-e2e", "--enabled", "false"]);
  await assertKeys(keys, false);
  await assertSource();
  pass("temporary Flag flip observed with both keys while source remains unchanged");

  stage = "CLI Sync";
  const synced = await cli(["envs", "sync", "--env", "pr-cli-e2e", "--from", "dev"]);
  check(
    synced.syncedFlags > 0 && synced.temporary?.syncedFromEnvironmentId === "env_checkout_dev_e2e",
    "CLI Sync missed Flags/source metadata",
  );
  await assertKeys(keys, true);
  await assertSource();
  pass("CLI Sync restores source values through both existing keys");

  stage = "temporary permission refusals";
  await checkPermissionRefusals(created);
  await cli([
    "flags",
    "promote",
    flag,
    "--env",
    "pr-cli-e2e",
    "--from-environment-id",
    sourceEnvironment,
    "--body-json",
    JSON.stringify({ select: { enabled: true } }),
  ]);
  await mcp("flags_promote", {
    targetEnvironmentId: created.id,
    by: "id",
    flagId: flag,
    fromEnvironmentId: sourceEnvironment,
    select: { enabled: true },
    idempotency_key: "temp-promote-allowed",
  });
  await assertKeys(keys, true);
  await assertSource();
  check(
    (await readdir(resolve(fleet.root, "cli"))).length === 0,
    "Token-only CLI wrote a local credential or context file",
  );
  pass(
    "CLI and MCP promote from prod into the token's Temporary Environment; clean working directory has no credential files",
  );
  stage = "CLI delete and revocation";
  check((await cli(["envs", "delete", "--env", "pr-cli-e2e"])).deleted, "CLI delete failed");
  await assertKeys(keys, "CREDENTIAL_REVOKED");
  pass("CLI delete revokes both keys at the public Evaluation edge");

  stage = "real MCP create, Sync and delete";
  const mcpCreated = await mcp("environments_create", {
    key: "pr-mcp-e2e",
    temporary: { fromEnvironmentId: "prod" },
  });
  check(
    mcpCreated.temporary?.syncedFromEnvironmentId === sourceEnvironment,
    "MCP create missed source metadata",
  );
  const mcpKeys = await keysFor(mcpCreated);
  await assertKeys(mcpKeys, true);
  check(
    (
      await mcp("environments_sync", {
        environmentId: mcpCreated.id,
        by: "id",
        fromEnvironmentId: "dev",
      })
    ).syncedFlags > 0,
    "MCP Sync did not copy Flags",
  );
  await assertKeys(mcpKeys, true);
  check(
    (await mcp("environments_delete", { environmentId: mcpCreated.id, by: "id" })).deleted,
    "MCP delete failed",
  );
  await assertKeys(mcpKeys, "CREDENTIAL_REVOKED");
  await assertSource();
  pass("real MCP Streamable HTTP/session delegation creates, Syncs and deletes; both keys revoked");

  await expiryLifecycle([created.id, mcpCreated.id]);
  await assertSource();
}

async function checkPermissionRefusals(created) {
  await fleet.sql(
    `INSERT INTO environments (id, app_id, key, name, policy, expires_at, synced_from_environment_id, synced_at, created_at, updated_at)
    SELECT 'env_temporary_foreign_e2e', 'app_billing_e2e', 'pr-foreign', 'Foreign Temporary', policy, expires_at, 'env_billing_prod_e2e', synced_at, created_at, updated_at FROM environments WHERE id='${created.id}';`,
    workSignal,
  );
  await checkTemporaryPermissionRefusals({
    client,
    secret: pat.secret,
    mcp,
    appId,
    flag,
    root: fleet.root,
  });
}

async function expiryLifecycle(deletedIds) {
  stage = "real-time expiry";
  const expiresAt = new Date(Date.now() + 75_000).toISOString();
  const expiring = await createTemporary("pr-expiry-e2e", expiresAt);
  const expiringKeys = await keysFor(expiring);
  await assertKeys(expiringKeys, true);
  console.log("Waiting for requested ISO expiry against the real clock");
  while (Date.now() <= Date.parse(expiresAt) + 100)
    await delay(Math.min(500, Date.parse(expiresAt) + 101 - Date.now()), undefined, {
      signal: workSignal,
    });
  await assertKeys(expiringKeys, "ENVIRONMENT_EXPIRED", expiresAt);
  pass("real ISO expiry returns HTTP410 ENVIRONMENT_EXPIRED for Client and API Keys");

  stage = "scheduled teardown and terminal revocation";
  const teardown = await fetch(`${fleet.origin}/__e2e/teardown`, {
    method: "POST",
    signal: AbortSignal.any([workSignal, AbortSignal.timeout(60_000)]),
  });
  check(teardown.ok && (await teardown.json()).complete, "Real Worker scheduled teardown failed");
  await assertKeys(expiringKeys, "CREDENTIAL_REVOKED");
  deletedIds.push(expiring.id);
  fleet.assertCleanup(deletedIds);
  check(
    !(await cli(["envs", "list"])).items.some((environment) => deletedIds.includes(environment.id)),
    "Deleted Environment remains in inventory",
  );
  pass(
    "actual scheduled teardown removes expired Environment, completes scoped Analysis cleanup and revokes both keys",
  );
}

try {
  const { SPLITCH_CLI_SMOKE_BINARY: binary } = process.env;
  await access(resolve(repoRoot, binary ?? "apps/cli/dist/cli.js"));
  fleet = await createLocalPatFixture(abort.signal, {
    full: true,
    owner: true,
    teardown: {
      module: "apps/control-plane-api/src/temporary-environment-teardown-scheduled.ts",
      exportName: "runTemporaryEnvironmentTeardown",
    },
  });
  stage = "six-Worker Wrangler startup";
  await fleet.start();
  pass("all six actual API Workers healthy in isolated Wrangler/Miniflare runtime");
  await fleet.run(async (signal) => {
    workSignal = signal;
    client = createPatClient(fleet, signal);
    stage = "session to private PAT";
    pat = await client.mint([
      { target: `app:${appId}`, role: "owner", permissions: ["write", "credentials", "delete"] },
    ]);
    await lifecycle();
  });
} catch (error) {
  failure = stage;
  const detail =
    error instanceof FixtureError
      ? error.message
      : `private exception ${error?.name ?? "unknown"}; diagnostics suppressed`;
  requireSafeOutput(detail);
  console.error(`FAIL temporary-environments-e2e at ${stage}: ${detail}`);
  console.error(JSON.stringify(fleet?.diagnostics() ?? {}));
  process.exitCode = 1;
} finally {
  try {
    for (const token of [pat, setupPat].filter(Boolean))
      await createPatClient(fleet, abort.signal).revoke(token.token.id);
  } catch {
    failure ??= "PAT cleanup";
    process.exitCode = 1;
  }
  try {
    await fleet?.close();
  } catch {
    failure ??= "runtime cleanup";
    process.exitCode = 1;
  }
  const report = {
    ok: !failure,
    failure: failure ?? null,
    passed,
    agent: fleet?.agent,
    runtime: "Wrangler multiworker: six real API Workers plus local gateway",
    completedAt: new Date().toISOString(),
  };
  await writeLocalEvidence("temporary-environments-e2e", report);
}

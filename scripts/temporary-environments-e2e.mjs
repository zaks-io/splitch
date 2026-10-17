#!/usr/bin/env node
import { access } from "node:fs/promises";
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

// Prerequisite: a fresh CLI build. Only issuer/Tinybird are synthetic; all six
// API Workers, D1, KV, Durable Objects, auth, CLI and MCP execute their real code.
const appId = "app_checkout_e2e";
const sourceEnvironment = "env_checkout_dev_e2e";
const flag = "temporary-e2e-flag";
const abort = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => abort.abort());
const passed = [];
let fleet, client, pat, sessionId, failure, workSignal;
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
    "dev",
    ...(expiresAt ? ["--expires-at", expiresAt] : []),
  ]);

async function assertKeys(keys, expected, expiresAt) {
  await Promise.all(keys.map((key) => assertKey(key, expected, expiresAt)));
}

async function assertKey(key, expected, expiresAt) {
  const status =
    typeof expected === "boolean" ? 200 : expected === "ENVIRONMENT_EXPIRED" ? 410 : 403;
  check(typeof key === "string", "Environment omitted credential material");
  const isClient = key.startsWith("pk_");
  const response = await fetch(
    `${fleet.serviceOrigin("evaluation-api")}/api/sdk/${isClient ? "evaluate" : "verify"}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        "idempotency-key": `temporary-e2e-${++sequence}`,
      },
      body: JSON.stringify({
        flagKey: flag,
        targetingKey: "local-temporary-e2e",
        idType: "user",
        attributes: {},
      }),
      signal: AbortSignal.any([workSignal, AbortSignal.timeout(30_000)]),
    },
  );
  const body = await response.json();
  check(
    response.status === status,
    `Data-plane ${isClient ? "Client" : "API"} Key HTTP ${response.status}; expected ${status}`,
  );
  const value = isClient ? body.variant : body.value;
  check(
    (typeof expected === "boolean" ? value : body.code) === expected,
    "Data-plane result did not match lifecycle state",
  );
  if (expiresAt)
    check(body.details?.expiredAt === expiresAt, "Expiry response lost its original ISO datetime");
}

async function mcp(name, args) {
  async function rpc(method, params) {
    const response = await fetch(`${fleet.serviceOrigin("mcp-server")}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${pat.secret}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method, params }),
      signal: AbortSignal.any([workSignal, AbortSignal.timeout(45_000)]),
    });
    check(response.ok, `MCP HTTP request failed with ${response.status}`);
    return response;
  }
  if (!sessionId) {
    const initialized = await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "temporary-environments-e2e", version: "1.0.0" },
    });
    sessionId = initialized.headers.get("mcp-session-id");
    check(
      sessionId && (await initialized.json()).result?.protocolVersion,
      "MCP initialization omitted session/protocol",
    );
  }
  const body = await (await rpc("tools/call", { name, arguments: { appId, ...args } })).json();
  check(
    body.result && !body.error && !body.result.isError,
    `MCP ${name} failed; private response suppressed`,
  );
  check(body.result.structuredContent, "MCP tool omitted structuredContent");
  return body.result.structuredContent;
}

async function lifecycle() {
  stage = "source Flag publication";
  await cli([
    "flags",
    "create",
    "--key",
    flag,
    "--lifecycle-class",
    "permission",
    "--variants",
    "on,off",
  ]);
  await cli([
    "flag-config",
    "update",
    flag,
    "--env",
    "dev",
    "--enabled",
    "true",
    "--body-json",
    JSON.stringify({ rollout: { percentage: 100 } }),
  ]);
  const source = await cli(["flag-config", "get", flag, "--env", "dev"]);
  const sourceClient = await cli(["client-key", "get", "--env", "dev"]);
  const sourceKeys = [
    sourceClient.keyMaterial,
    await client.apiKey(pat.secret, appId, sourceEnvironment),
  ];
  const assertSource = async () => {
    await assertKeys(sourceKeys, true);
    check(
      isDeepStrictEqual(source, await cli(["flag-config", "get", flag, "--env", "dev"])),
      "Temporary operation changed the source Configuration",
    );
  };
  await assertKeys(sourceKeys, true);
  pass("source Configuration published through real ConfigStore and readable with both keys");

  stage = "CLI Temporary Environment create";
  const created = await createTemporary("pr-cli-e2e");
  check(
    created.temporary?.syncedFromEnvironmentId === sourceEnvironment,
    "CLI create missed source metadata",
  );
  const keys = await keysFor(created);
  await assertKeys(keys, true);
  pass("built CLI --temporary --from dev; auto Client Key and private API Key observe the copy");

  stage = "temporary Flag flip and source isolation";
  await cli(["flag-config", "update", flag, "--env", "pr-cli-e2e", "--enabled", "false"]);
  await assertKeys(keys, false);
  await assertSource();
  pass("temporary Flag flip observed with both keys while source remains unchanged");

  stage = "CLI Sync";
  const synced = await cli(["envs", "sync", "--env", "pr-cli-e2e", "--from", "dev"]);
  check(
    synced.syncedFlags > 0 && synced.temporary?.syncedFromEnvironmentId === sourceEnvironment,
    "CLI Sync missed Flags/source metadata",
  );
  await assertKeys(keys, true);
  await assertSource();
  pass("CLI Sync restores source values through both existing keys");

  stage = "CLI delete and revocation";
  check((await cli(["envs", "delete", "--env", "pr-cli-e2e"])).deleted, "CLI delete failed");
  await assertKeys(keys, "CREDENTIAL_REVOKED");
  pass("CLI delete revokes both keys at the public Evaluation edge");

  stage = "real MCP create, Sync and delete";
  const mcpCreated = await mcp("environments_create", {
    key: "pr-mcp-e2e",
    temporary: { fromEnvironmentId: "dev" },
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
    error instanceof FixtureError ? error.message : "private native diagnostics suppressed";
  requireSafeOutput(detail);
  console.error(`FAIL temporary-environments-e2e at ${stage}: ${detail}`);
  console.error(JSON.stringify(fleet?.diagnostics() ?? {}));
  process.exitCode = 1;
} finally {
  try {
    if (pat) await createPatClient(fleet, abort.signal).revoke(pat.token.id);
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

import type { ErrorResponse } from "@splitch/contracts";
import { appScope, createRepository, envScope } from "@splitch/db";
import type { RateLimiter } from "@splitch/worker-runtime";
import type { Hono } from "hono";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { makeControlPlaneAuthResolver } from "../src/auth-resolver";
import { type FixtureSigner, makeFixtureSigner } from "../src/fixture-signer";
import { makeJwksVerifier } from "../src/jwks-verify";
import { makeSessionStore } from "../src/session-store";
import type { LocalBindings } from "../src/test-fixtures";
import { seedOrgApp, seedOrgMember } from "../src/test-seeds";
import { makePoolBindings as makeLocalBindings } from "./pool-bindings";
import { noOpExposureStatusCleanup } from "./exposure-status-cleanup-fixture";
import { noOpHoldoverWriteOutboxCleanup } from "./holdover-write-outbox-cleanup-fixture";

const AUDIENCE = "https://cp.splitch.test";
const NOW_MS = Date.UTC(2026, 6, 2, 12, 0, 0);
const NOW_ISO = new Date(NOW_MS).toISOString();
const ORG = {
  orgId: "org_app_env_delete_guards",
  orgName: "App Env Delete Guards Co",
  appId: "app_existing_delete_guards",
  appName: "Existing Delete Guards App",
  appKey: "existing-delete-guards",
};
const OWNER = "user_app_env_delete_owner";

const allowLimiter: RateLimiter = () => ({ limited: false });
const nowSeconds = () => Math.floor(NOW_MS / 1000);

interface Harness {
  app: Hono;
  signer: FixtureSigner;
  bindings: LocalBindings;
}

let h: Harness;

// The Workers pool isolates storage per FILE, not per test (isolatedStorage was
// dropped in the Vitest 4 migration -- workers-sdk#12889), so the fixed-ID seed
// rows are inserted once here instead of in `beforeEach`, which would trip the
// slug unique index on the second test. Each test still gets its own harness.
beforeAll(async () => {
  const bindings = await makeLocalBindings();
  await seedOrgApp(bindings.d1, ORG);
  await seedOrgMember(bindings.d1, {
    orgId: ORG.orgId,
    userId: OWNER,
    role: "owner",
  });
});

beforeEach(async () => {
  const bindings = await makeLocalBindings();

  const signer = await makeFixtureSigner();
  const verifier = makeJwksVerifier({
    fetchJwks: async () => signer.jwks,
    controlPlaneAudience: AUDIENCE,
  });
  h = {
    app: createApp({
      authResolver: makeControlPlaneAuthResolver({
        verifier,
        sessions: makeSessionStore(bindings.kv),
        now: () => NOW_MS,
      }),
      rateLimiter: allowLimiter,
      repo: createRepository(bindings.d1),
      credentialStore: bindings.credentialKv,
      exposureStatusCleanup: noOpExposureStatusCleanup,
      holdoverWriteOutboxCleanup: noOpHoldoverWriteOutboxCleanup,
      nowIso: () => NOW_ISO,
    }),
    signer,
    bindings,
  };
});

afterEach(async () => h.bindings.dispose());

function orgToken(): Promise<string> {
  return h.signer.sign({
    sub: OWNER,
    iss: "https://auth.splitch.test",
    aud: AUDIENCE,
    iat: nowSeconds(),
    exp: nowSeconds() + 3600,
    scopes: [`org:${ORG.orgId}:owner`],
  });
}

function appToken(appId: string): Promise<string> {
  return h.signer.sign({
    sub: OWNER,
    iss: "https://auth.splitch.test",
    aud: AUDIENCE,
    iat: nowSeconds(),
    exp: nowSeconds() + 3600,
    scopes: [`app:${appId}:owner`],
  });
}

async function request(method: string, path: string, jwt: string): Promise<Response> {
  return h.app.request(path, { method, headers: { authorization: `Bearer ${jwt}` } });
}

async function createDefaultApp(key = "checkout") {
  const res = await h.app.request(`/orgs/${ORG.orgId}/apps`, {
    method: "POST",
    headers: { authorization: `Bearer ${await orgToken()}`, "content-type": "application/json" },
    body: JSON.stringify({
      organizationId: ORG.orgId,
      name: key === "checkout" ? "Checkout" : `Checkout ${key}`,
      key,
    }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    app: { id: string };
    environments: Array<{ id: string; key: string }>;
  };
}

async function seedRunningExperiment(appId: string, environmentId: string, suffix = "primary") {
  const repo = createRepository(h.bindings.d1);
  const scope = envScope(appId, environmentId);
  const experimentId = `exp_delete_guard_${suffix}`;
  const runId = `run_delete_guard_${suffix}`;
  const flagId = `flag_delete_guard_${suffix}`;
  // `experiments.flag_id` is a real foreign key into `flags`. The Node harness's
  // hand-written schema declares no foreign keys at all, so this row used to
  // insert against a flag that never existed; the migrated schema rejects it.
  await repo.flags.flags.insert(appScope(appId), {
    id: flagId,
    appId,
    key: `delete-guard-${suffix}`,
    name: "Delete guard",
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  });
  await repo.experiments.experiments.insert(scope, {
    id: experimentId,
    appId,
    environmentId,
    key: `delete-guard-${suffix}`,
    flagId,
    name: "Delete guard",
    status: "running",
    targetingKeyField: "userId",
    targetingKeyType: "user",
    metrics: "[]",
    guardrailMetrics: "[]",
    dimensions: "[]",
    liveRunId: runId,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  });
  await repo.experiments.runs.insert(scope, {
    id: runId,
    appId,
    environmentId,
    experimentId,
    runNumber: 1,
    targetingKeyField: "userId",
    targetingKeyType: "user",
    salt: `salt_delete_guard_${suffix}`,
    allocation: JSON.stringify({ control: 100 }),
    variantSet: JSON.stringify([
      {
        id: `variant_control_delete_guard_${suffix}`,
        name: "control",
        value: false,
      },
    ]),
    controlVariantId: `variant_control_delete_guard_${suffix}`,
    targetingRules: "[]",
    confidenceLevel: 0.95,
    decisionFamily: "[]",
    guardrailDecisions: "[]",
    configHash: "hash_delete_guard",
    startedAt: NOW_ISO,
    createdAt: NOW_ISO,
  });
}

async function seedFlagConfig(appId: string, environmentId: string, suffix = "primary") {
  const repo = createRepository(h.bindings.d1);
  const flagId = `flag_delete_block_${suffix}`;
  await repo.flags.flags.insert(appScope(appId), {
    id: flagId,
    appId,
    key: `delete-block-${suffix}`,
    name: "Delete block",
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  });
  await repo.flags.flagConfigs.insert(envScope(appId, environmentId), {
    id: `cfg_delete_block_${suffix}`,
    appId,
    environmentId,
    flagId,
    enabled: false,
    availableVariantNames: "[]",
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  });
}

async function seedAppFlag(appId: string, suffix = "primary") {
  await createRepository(h.bindings.d1).flags.flags.insert(appScope(appId), {
    id: `flag_app_delete_block_${suffix}`,
    appId,
    key: `app-delete-block-${suffix}`,
    name: "App delete block",
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  });
}

async function errorBody(res: Response): Promise<ErrorResponse> {
  return (await res.json()) as ErrorResponse;
}

describe("control-plane App and Environment delete guards", () => {
  it("blocks App and Environment deletes for running Experiments and last Environment", async () => {
    const created = await createDefaultApp();
    const jwt = await appToken(created.app.id);
    const prod = created.environments.find((env) => env.key === "prod");
    expect(prod).toBeDefined();
    await seedRunningExperiment(created.app.id, prod?.id ?? "");
    await seedRunningExperiment(created.app.id, prod?.id ?? "", "secondary");

    const deleteApp = await request("DELETE", `/apps/${created.app.id}`, jwt);
    expect(deleteApp.status).toBe(409);
    expect((await errorBody(deleteApp)).code).toBe("EXPERIMENT_RUNNING");

    const deleteProd = await request("DELETE", `/apps/${created.app.id}/envs/${prod?.id}`, jwt);
    expect(deleteProd.status).toBe(409);
    expect((await errorBody(deleteProd)).code).toBe("EXPERIMENT_RUNNING");

    const dev = created.environments.find((env) => env.key === "dev");
    expect(dev).toBeDefined();
    const deleteDev = await request("DELETE", `/apps/${created.app.id}/envs/${dev?.id}`, jwt);
    expect(deleteDev.status).toBe(200);

    await createRepository(h.bindings.d1).experiments.experiments.update(
      envScope(created.app.id, prod?.id ?? ""),
      { status: "ended", liveRunId: null, updatedAt: NOW_ISO },
    );
    const deleteLast = await request("DELETE", `/apps/${created.app.id}/envs/${prod?.id}`, jwt);
    expect(deleteLast.status).toBe(409);
    expect((await errorBody(deleteLast)).code).toBe("LAST_ENVIRONMENT_REQUIRED");
  });

  it("blocks non-empty App and Environment deletes before credential deletion", async () => {
    const envChild = await createDefaultApp("env-child");
    const envJwt = await appToken(envChild.app.id);
    const prod = envChild.environments.find((env) => env.key === "prod");
    expect(prod).toBeDefined();
    await seedFlagConfig(envChild.app.id, prod?.id ?? "", "env");

    const repo = createRepository(h.bindings.d1);
    const prodScope = envScope(envChild.app.id, prod?.id ?? "");
    const prodKeysBefore = await repo.credentials.listClientKeys(prodScope);
    expect(prodKeysBefore).toHaveLength(1);

    const deleteProd = await request("DELETE", `/apps/${envChild.app.id}/envs/${prod?.id}`, envJwt);
    expect(deleteProd.status).toBe(409);
    expect((await errorBody(deleteProd)).code).toBe("RESOURCE_NOT_EMPTY");
    expect(await repo.credentials.listClientKeys(prodScope)).toEqual(prodKeysBefore);

    const endedChild = await createDefaultApp("ended-child");
    const endedJwt = await appToken(endedChild.app.id);
    const endedProd = endedChild.environments.find((env) => env.key === "prod");
    expect(endedProd).toBeDefined();
    await seedRunningExperiment(endedChild.app.id, endedProd?.id ?? "", "ended");
    await repo.experiments.experiments.update(envScope(endedChild.app.id, endedProd?.id ?? ""), {
      status: "ended",
      liveRunId: null,
      updatedAt: NOW_ISO,
    });
    const endedProdScope = envScope(endedChild.app.id, endedProd?.id ?? "");
    const endedKeysBefore = await repo.credentials.listClientKeys(endedProdScope);

    const deleteEnded = await request(
      "DELETE",
      `/apps/${endedChild.app.id}/envs/${endedProd?.id}`,
      endedJwt,
    );
    expect(deleteEnded.status).toBe(409);
    expect((await errorBody(deleteEnded)).code).toBe("RESOURCE_NOT_EMPTY");
    expect(await repo.credentials.listClientKeys(endedProdScope)).toEqual(endedKeysBefore);

    const appChild = await createDefaultApp("app-child");
    const appJwt = await appToken(appChild.app.id);
    await seedAppFlag(appChild.app.id, "app");
    const appKeyScopes = appChild.environments.map((env) => envScope(appChild.app.id, env.id));
    const appKeysBefore = await Promise.all(
      appKeyScopes.map((scope) => repo.credentials.listClientKeys(scope)),
    );

    const deleteApp = await request("DELETE", `/apps/${appChild.app.id}`, appJwt);
    expect(deleteApp.status).toBe(409);
    expect((await errorBody(deleteApp)).code).toBe("RESOURCE_NOT_EMPTY");
    await Promise.all(
      appKeyScopes.map(async (scope, index) =>
        expect(await repo.credentials.listClientKeys(scope)).toEqual(appKeysBefore[index]),
      ),
    );
  });
});

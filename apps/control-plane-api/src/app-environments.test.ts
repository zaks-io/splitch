import { deriveMcpTools, getRoute, type ErrorResponse } from "@splitch/contracts";
import { createRepository, envScope } from "@splitch/db";
import type { RateLimiter } from "@splitch/worker-runtime";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { makeControlPlaneAuthResolver } from "./auth-resolver.js";
import { type FixtureSigner, makeFixtureSigner } from "./fixture-signer.js";
import { makeJwksVerifier } from "./jwks-verify.js";
import { makeSessionStore } from "./session-store.js";
import {
  type LocalBindings,
  makeLocalBindings,
  seedOrgApp,
  seedOrgMember,
} from "./test-fixtures.js";

const AUDIENCE = "https://cp.splitch.test";
const NOW_MS = Date.UTC(2026, 6, 2, 12, 0, 0);
const NOW_ISO = new Date(NOW_MS).toISOString();
const ORG = {
  orgId: "org_app_env_crud",
  orgName: "App Env CRUD Co",
  appId: "app_existing_crud",
  appName: "Existing App",
  appKey: "existing-app",
};
const OWNER = "user_app_env_owner";

const allowLimiter: RateLimiter = () => ({ limited: false });
const nowSeconds = () => Math.floor(NOW_MS / 1000);

interface Harness {
  app: Hono;
  signer: FixtureSigner;
  bindings: LocalBindings;
}

let h: Harness;

beforeEach(async () => {
  const bindings = await makeLocalBindings();
  await seedOrgApp(bindings.d1, ORG);
  await seedOrgMember(bindings.d1, {
    orgId: ORG.orgId,
    userId: OWNER,
    role: "owner",
  });

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
    scopes: [`app:${appId}:admin`],
  });
}

async function request(
  method: string,
  path: string,
  jwt: string,
  body?: Record<string, unknown>,
): Promise<Response> {
  return h.app.request(path, {
    method,
    headers: {
      authorization: `Bearer ${jwt}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function createDefaultApp() {
  const res = await request("POST", `/orgs/${ORG.orgId}/apps`, await orgToken(), {
    organizationId: ORG.orgId,
    name: "Checkout",
    key: "checkout",
  });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    app: { id: string; name: string; key: string };
    environments: Array<{ id: string; key: string; policy: Record<string, string> }>;
    clientKeys: Array<{ keyId: string; environmentId: string; isOriginOpen: boolean }>;
  };
}

async function seedRunningExperiment(appId: string, environmentId: string, suffix = "primary") {
  const repo = createRepository(h.bindings.d1);
  const scope = envScope(appId, environmentId);
  const experimentId = `exp_delete_guard_${suffix}`;
  const runId = `run_delete_guard_${suffix}`;
  await repo.experiments.experiments.insert(scope, {
    id: experimentId,
    appId,
    environmentId,
    key: `delete-guard-${suffix}`,
    flagId: `flag_delete_guard_${suffix}`,
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
    variantSet: "[]",
    targetingRules: "[]",
    confidenceLevel: 0.95,
    decisionFamily: "[]",
    guardrailDecisions: "[]",
    configHash: "hash_delete_guard",
    startedAt: NOW_ISO,
    createdAt: NOW_ISO,
  });
}

async function errorBody(res: Response): Promise<ErrorResponse> {
  return (await res.json()) as ErrorResponse;
}

describe("control-plane App and Environment CRUD", () => {
  it("creates an App with dev/prod Environments and open Client Keys", async () => {
    const created = await createDefaultApp();
    expect(created.app).toMatchObject({ name: "Checkout", key: "checkout" });
    expect(created.environments.map((env) => env.key)).toEqual(["dev", "prod"]);
    expect(created.environments[0]?.policy).toMatchObject({ enabledState: "allow" });
    expect(created.environments[1]?.policy).toMatchObject({ enabledState: "confirm" });
    expect(created.clientKeys).toHaveLength(2);
    expect(created.clientKeys.every((key) => key.isOriginOpen)).toBe(true);

    const repo = createRepository(h.bindings.d1);
    for (const env of created.environments) {
      const keys = await repo.credentials.listClientKeys(envScope(created.app.id, env.id));
      expect(keys.filter((key) => !key.revokedAt)).toHaveLength(1);
    }
  });

  it("round-trips App and Environment CRUD plus prod Policy patch", async () => {
    const created = await createDefaultApp();
    const jwt = await appToken(created.app.id);
    const prod = created.environments.find((env) => env.key === "prod");
    expect(prod).toBeDefined();

    const getApp = await request("GET", `/apps/${created.app.id}`, jwt);
    expect(getApp.status).toBe(200);
    expect(await getApp.json()).toMatchObject({ id: created.app.id, key: "checkout" });

    const patchApp = await request("PATCH", `/apps/${created.app.id}`, jwt, {
      name: "Checkout Renamed",
    });
    expect(patchApp.status).toBe(200);
    expect(await patchApp.json()).toMatchObject({ name: "Checkout Renamed" });

    const listEnvs = await request("GET", `/apps/${created.app.id}/envs`, jwt);
    expect(listEnvs.status).toBe(200);
    expect(((await listEnvs.json()) as { items: unknown[] }).items).toHaveLength(2);

    const confirmPolicy = {
      variantAvailability: "confirm",
      targetingRolloutValue: "confirm",
      enabledState: "confirm",
      startExperimentRun: "confirm",
    };
    const patchProd = await request("PATCH", `/apps/${created.app.id}/envs/${prod?.id}`, jwt, {
      policy: confirmPolicy,
    });
    expect(patchProd.status).toBe(200);
    expect(await patchProd.json()).toMatchObject({ id: prod?.id, policy: confirmPolicy });

    const qa = await request("POST", `/apps/${created.app.id}/envs`, jwt, {
      key: "qa",
      name: "QA",
    });
    expect(qa.status).toBe(200);
    const qaBody = (await qa.json()) as { id: string; policy: Record<string, string> };
    expect(qaBody.policy.enabledState).toBe("allow");
    expect(
      await createRepository(h.bindings.d1).credentials.listClientKeys(
        envScope(created.app.id, qaBody.id),
      ),
    ).toHaveLength(1);

    const deleteQa = await request("DELETE", `/apps/${created.app.id}/envs/${qaBody.id}`, jwt);
    expect(deleteQa.status).toBe(200);
    expect(await deleteQa.json()).toEqual({ deleted: true });
  });

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

  it("derives App and Environment MCP tools from the same routes", () => {
    const tools = deriveMcpTools();
    const expected = [
      "apps_create",
      "environments_list",
      "environments_create",
      "environments_get",
      "environments_update",
      "environments_delete",
    ] as const;

    for (const operationId of expected) {
      const route = getRoute(operationId);
      const tool = tools.find((candidate) => candidate.name === operationId);
      expect(route).toBeDefined();
      expect(tool).toBeDefined();
      expect(tool?.outputSchema).toBe(route?.output);
    }
  });
});

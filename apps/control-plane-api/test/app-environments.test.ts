import { deriveMcpTools, getRoute } from "@splitch/contracts";
import { createRepository, envScope } from "@splitch/db";
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

// The Workers pool isolates storage per FILE, not per test (isolatedStorage was
// dropped in the Vitest 4 migration -- workers-sdk#12889), so re-seeding the
// same Organization in `beforeEach` trips the slug unique index on the second
// test. The Org and its owner are read-only roots here: every test creates its
// own App through the API, so seeding them once per file is equivalent.
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

function appToken(appId: string, role: "owner" | "admin" | "member" = "admin"): Promise<string> {
  return h.signer.sign({
    sub: OWNER,
    iss: "https://auth.splitch.test",
    aud: AUDIENCE,
    iat: nowSeconds(),
    exp: nowSeconds() + 3600,
    scopes: [`app:${appId}:${role}`],
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

async function createDefaultApp(key = "checkout") {
  const res = await request("POST", `/orgs/${ORG.orgId}/apps`, await orgToken(), {
    organizationId: ORG.orgId,
    name: key === "checkout" ? "Checkout" : `Checkout ${key}`,
    key,
  });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    app: { id: string; name: string; key: string };
    environments: Array<{ id: string; key: string; policy: Record<string, string> }>;
    clientKeys: Array<{ keyId: string; environmentId: string; isOriginOpen: boolean }>;
  };
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

  it("derives the App key from the name, so a caller with only a name gets an App", async () => {
    // An agent reads the create tool's required fields, sends a display name,
    // and must not have to invent a handle. Same contract as an Organization slug.
    const res = await request("POST", `/orgs/${ORG.orgId}/apps`, await orgToken(), {
      name: "Mobile Checkout v2",
    });

    expect(res.status).toBe(200);
    expect((await res.json()) as { app: { key: string } }).toMatchObject({
      app: { name: "Mobile Checkout v2", key: "mobile-checkout-v2" },
    });
  });

  it("fails loud when no key can be derived, naming the field to supply", async () => {
    const res = await request("POST", `/orgs/${ORG.orgId}/apps`, await orgToken(), {
      name: "🚀🚀",
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; message: string; details: unknown };
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(body.message).toContain('supply an explicit "key"');
    expect(body.details).toMatchObject({ issues: [{ path: ["key"] }] });
  });

  it("round-trips App and Environment CRUD plus prod Policy patch", async () => {
    // A distinct key per test: storage is shared across the file, so reusing
    // "checkout" would collide with the App the previous test created.
    const created = await createDefaultApp("checkout-crud");
    const ownerJwt = await appToken(created.app.id, "owner");
    const prod = created.environments.find((env) => env.key === "prod");
    expect(prod).toBeDefined();

    const getApp = await request("GET", `/apps/${created.app.id}`, ownerJwt);
    expect(getApp.status).toBe(200);
    expect(await getApp.json()).toMatchObject({ id: created.app.id, key: "checkout-crud" });

    const patchApp = await request("PATCH", `/apps/${created.app.id}`, ownerJwt, {
      name: "Checkout Renamed",
    });
    expect(patchApp.status).toBe(200);
    expect(await patchApp.json()).toMatchObject({ name: "Checkout Renamed" });

    const listEnvs = await request("GET", `/apps/${created.app.id}/envs`, ownerJwt);
    expect(listEnvs.status).toBe(200);
    expect(((await listEnvs.json()) as { items: unknown[] }).items).toHaveLength(2);

    const confirmPolicy = {
      variantAvailability: "confirm",
      targetingRolloutValue: "confirm",
      enabledState: "confirm",
      startExperimentRun: "confirm",
    };
    const patchProd = await request("PATCH", `/apps/${created.app.id}/envs/${prod?.id}`, ownerJwt, {
      policy: confirmPolicy,
    });
    expect(patchProd.status).toBe(200);
    expect(await patchProd.json()).toMatchObject({ id: prod?.id, policy: confirmPolicy });

    const qa = await request("POST", `/apps/${created.app.id}/envs`, ownerJwt, {
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

    const deleteQa = await request("DELETE", `/apps/${created.app.id}/envs/${qaBody.id}`, ownerJwt);
    expect(deleteQa.status).toBe(200);
    expect(await deleteQa.json()).toEqual({ deleted: true });
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

import type { ErrorResponse } from "@splitch/contracts";
import { createRepository } from "@splitch/db";
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
  orgId: "org_app_env_authz",
  orgName: "App Env Authz Co",
  appId: "app_existing_authz",
  appName: "Existing Authz App",
  appKey: "existing-authz",
};
const OWNER = "user_app_env_authz_owner";
type AppRole = "owner" | "admin" | "member";

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

function appToken(appId: string, role: AppRole): Promise<string> {
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
    app: { id: string };
    environments: Array<{ id: string; key: string }>;
  };
}

async function appTokenFromCreatedMembership(appId: string): Promise<string> {
  const row = await h.bindings.d1
    .prepare("SELECT role FROM app_memberships WHERE app_id = ? AND user_id = ?")
    .bind(appId, OWNER)
    .first<{ role: AppRole }>();
  expect(row?.role).toBe("owner");
  return appToken(appId, row?.role ?? "member");
}

async function errorBody(res: Response): Promise<ErrorResponse> {
  return (await res.json()) as ErrorResponse;
}

describe("control-plane App and Environment role gates", () => {
  it("enforces App owner/admin writes and owner-only deletes", async () => {
    const created = await createDefaultApp();
    const ownerJwt = await appTokenFromCreatedMembership(created.app.id);
    const adminJwt = await appToken(created.app.id, "admin");
    const prod = created.environments.find((env) => env.key === "prod");
    expect(prod).toBeDefined();

    const ownerPatchApp = await request("PATCH", `/apps/${created.app.id}`, ownerJwt, {
      name: "Owner Renamed",
    });
    expect(ownerPatchApp.status).toBe(200);

    const adminPatchApp = await request("PATCH", `/apps/${created.app.id}`, adminJwt, {
      name: "Admin Renamed",
    });
    expect(adminPatchApp.status).toBe(200);

    const ownerPatchEnv = await request(
      "PATCH",
      `/apps/${created.app.id}/envs/${prod?.id}`,
      ownerJwt,
      { name: "Production" },
    );
    expect(ownerPatchEnv.status).toBe(200);

    const adminEnv = await request("POST", `/apps/${created.app.id}/envs`, adminJwt, {
      key: "qa",
      name: "QA",
    });
    expect(adminEnv.status).toBe(200);
    const adminEnvBody = (await adminEnv.json()) as { id: string };

    const adminDeleteEnv = await request(
      "DELETE",
      `/apps/${created.app.id}/envs/${adminEnvBody.id}`,
      adminJwt,
    );
    expect(adminDeleteEnv.status).toBe(403);
    expect((await errorBody(adminDeleteEnv)).code).toBe("INSUFFICIENT_SCOPES");

    const ownerDeleteEnv = await request(
      "DELETE",
      `/apps/${created.app.id}/envs/${adminEnvBody.id}`,
      ownerJwt,
    );
    expect(ownerDeleteEnv.status).toBe(200);

    const adminDeleteApp = await request("DELETE", `/apps/${created.app.id}`, adminJwt);
    expect(adminDeleteApp.status).toBe(403);
    expect((await errorBody(adminDeleteApp)).code).toBe("INSUFFICIENT_SCOPES");

    const deleteCreated = await createDefaultApp("delete-target");
    const deleteOwnerJwt = await appTokenFromCreatedMembership(deleteCreated.app.id);
    const ownerDeleteApp = await request("DELETE", `/apps/${deleteCreated.app.id}`, deleteOwnerJwt);
    expect(ownerDeleteApp.status).toBe(200);
  });
});

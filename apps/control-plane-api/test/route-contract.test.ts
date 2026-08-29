import { type ErrorResponse, routeRegistry } from "@splitch/contracts";
import { createRepository } from "@splitch/db";
import type { RateLimiter } from "@splitch/worker-runtime";
import type { Hono } from "hono";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { makeControlPlaneAuthResolver } from "../src/auth-resolver";
import { type FixtureSigner, makeFixtureSigner } from "../src/fixture-signer";
import { makeJwksVerifier } from "../src/jwks-verify";
import { appAdminScope } from "../src/scope-binding";
import { makeSessionStore } from "../src/session-store";
import type { LocalBindings } from "../src/test-fixtures";
import { seedOrgApp, seedOrgMember } from "../src/test-seeds";
import { makePoolBindings as makeLocalBindings } from "./pool-bindings";

const AUDIENCE = "https://cp.splitch.test";
const NOW_MS = Date.UTC(2026, 6, 18, 12, 0, 0);
const PRIMARY = {
  orgId: "org_primary_route_contract",
  orgName: "Primary Route Contract",
  appId: "app_primary_route_contract",
  appName: "Primary",
  appKey: "primary",
};
const SECONDARY = {
  orgId: "org_secondary_route_contract",
  orgName: "Secondary Route Contract",
  appId: "app_secondary_route_contract",
  appName: "Secondary",
  appKey: "secondary",
};
const USER = "user_route_contract";
const ORG_OWNER = "user_route_contract_owner";
const APP_ADMIN = "user_route_contract_app_admin";
const REQUESTER = "user_route_contract_requester";
const OUTSIDER = "user_route_contract_outsider";
const PRIVACY_REQUEST_ID = "privacy_request_route_contract";
const allowLimiter: RateLimiter = () => ({ limited: false });

interface Harness {
  app: Hono;
  bindings: LocalBindings;
  signer: FixtureSigner;
}

let h: Harness;

// The Workers pool isolates storage per FILE, not per test (isolatedStorage was
// dropped in the Vitest 4 migration -- workers-sdk#12889), so the fixed-ID seed
// rows go in once here instead of per test, where they would trip the unique
// indexes on the second run. Every test in this file asserts a 401/403/503
// refusal, so nothing it does mutates these rows.
beforeAll(async () => {
  const bindings = await makeLocalBindings();
  await seedOrgApp(bindings.d1, PRIMARY);
  await seedOrgApp(bindings.d1, SECONDARY);
  await seedOrgMember(bindings.d1, { orgId: PRIMARY.orgId, userId: USER, role: "member" });
  await seedOrgMember(bindings.d1, { orgId: SECONDARY.orgId, userId: USER, role: "member" });
  await seedOrgMember(bindings.d1, { orgId: PRIMARY.orgId, userId: ORG_OWNER, role: "owner" });
  await seedAppMember(bindings, PRIMARY.appId, APP_ADMIN, "admin");
  await seedPrivacyRequest(bindings, {
    requestId: PRIVACY_REQUEST_ID,
    orgId: PRIMARY.orgId,
    appId: PRIMARY.appId,
    requestedBy: REQUESTER,
  });
});

beforeEach(async () => {
  const bindings = await makeLocalBindings();
  const signer = await makeFixtureSigner();
  h = {
    app: createApp({
      door: "binding",
      authResolver: makeControlPlaneAuthResolver({
        verifier: makeJwksVerifier({
          issuer: "https://auth.splitch.test",
          fetchJwks: async () => signer.jwks,
          controlPlaneAudience: AUDIENCE,
        }),
        sessions: makeSessionStore(bindings.kv),
        membershipAccess: {
          authorize: async () => true,
          resolve: async () => {
            throw new Error("test fixture has no wide membership resolver");
          },
        },
        now: () => NOW_MS,
      }),
      rateLimiter: allowLimiter,
      repo: createRepository(bindings.d1),
      convex: {},
      cloudflare: {},
      sentry: {},
    }),
    bindings,
    signer,
  };
});

afterEach(async () => h.bindings.dispose());

describe("control-plane route contract", () => {
  it("mounts every implemented Control Plane route", () => {
    const expected = routeRegistry
      .filter((route) => route.owner === "control-plane-api")
      .map((route) => `${route.method} ${route.path}`)
      .sort();
    const mounted = (h.app as unknown as { routes: Array<{ method: string; path: string }> }).routes
      .map((route) => `${route.method} ${route.path}`)
      .filter((route) => expected.includes(route))
      .sort();

    expect(mounted).toEqual(expected);
  });

  it("returns typed errors for protected organization and privacy routes", async () => {
    const [orgs, privacy] = await Promise.all([
      h.app.request("/orgs"),
      h.app.request("/users/me/privacy/export", { method: "POST" }),
    ]);

    expect(orgs.status).toBe(401);
    expect(((await orgs.json()) as ErrorResponse).code).toBe("UNAUTHORIZED");
    expect(privacy.status).toBe(401);
    expect(((await privacy.json()) as ErrorResponse).code).toBe("UNAUTHORIZED");
  });

  async function listOrgIds(jwt: string): Promise<string[]> {
    const response = await h.app.request("/orgs", {
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: Array<{ id: string }> };
    return body.items.map((org) => org.id).sort();
  }

  it("shows a device_flow cold-start token every Organization it is a member of", async () => {
    // The cold-start token carries no scopes at all; filtering by them would
    // return an empty list and deadlock the first step of every agent journey.
    const coldStart = await token([], USER, "device_flow");

    expect(await listOrgIds(coldStart)).toEqual([PRIMARY.orgId, SECONDARY.orgId].sort());
  });

  it("keeps the scope narrowing for doors that cannot rebind", async () => {
    // A device_flow session can rebind to any of its Orgs through the refresh
    // grant, so listing them grants it nothing. A refresh-less token (claim
    // ceremony, client_credentials) is genuinely narrowed by its scopes, so
    // discovery must not hand it the Orgs it was not scoped to.
    const narrowed = await token([`org:${PRIMARY.orgId}:member`], USER, "id_jag");

    expect(await listOrgIds(narrowed)).toEqual([PRIMARY.orgId]);
  });

  it("never lets a scope widen discovery past live membership", async () => {
    // A stranger sees nothing regardless of what its scopes claim, on either door.
    const stranger = await token([`org:${PRIMARY.orgId}:owner`], OUTSIDER);
    const strangerDeviceFlow = await token([`org:${PRIMARY.orgId}:owner`], OUTSIDER, "device_flow");

    expect(await listOrgIds(stranger)).toEqual([]);
    expect(await listOrgIds(strangerDeviceFlow)).toEqual([]);
  });

  it("serves generated OpenAPI publicly and unavailable privacy workflows as typed errors", async () => {
    const jwt = await token([appAdminScope(PRIMARY.appId)]);
    const [openapi, privacy] = await Promise.all([
      h.app.request("/.well-known/openapi.json"),
      h.app.request("/users/me/privacy/export", {
        method: "POST",
        headers: { authorization: `Bearer ${jwt}` },
      }),
    ]);

    expect(openapi.status).toBe(200);
    expect(await openapi.json()).toMatchObject({ openapi: "3.1.0", paths: { "/orgs": {} } });
    expect(privacy.status).toBe(503);
    expect(((await privacy.json()) as ErrorResponse).code).toBe("SERVICE_UNAVAILABLE");
  });

  it("enforces owner and admin gates before unavailable Org and App operations", async () => {
    const ownerJwt = await token([`org:${PRIMARY.orgId}:owner`], ORG_OWNER);
    const adminJwt = await token([appAdminScope(PRIMARY.appId)], APP_ADMIN);

    const ownerResponses = await Promise.all([
      request("DELETE", `/orgs/${PRIMARY.orgId}`, ownerJwt),
      request("POST", `/orgs/${PRIMARY.orgId}/privacy/export`, ownerJwt),
    ]);
    const adminResponses = await Promise.all([
      request("POST", `/apps/${PRIMARY.appId}/privacy/export`, adminJwt),
      request("POST", `/apps/${PRIMARY.appId}/privacy/entities/export`, adminJwt, entityBody()),
      request("POST", `/apps/${PRIMARY.appId}/privacy/entities/delete`, adminJwt, entityBody()),
    ]);

    for (const response of [...ownerResponses, ...adminResponses]) {
      expect(response.status).toBe(503);
      expect(((await response.json()) as ErrorResponse).code).toBe("SERVICE_UNAVAILABLE");
    }
  });

  it("rejects members and unrelated principals before unavailable Org and App operations", async () => {
    const memberOrgJwt = await token([`org:${PRIMARY.orgId}:member`]);
    const outsiderOrgJwt = await token([`org:${PRIMARY.orgId}:owner`], OUTSIDER);
    const memberAppJwt = await token([`app:${PRIMARY.appId}:member`]);
    const outsiderAppJwt = await token([appAdminScope(PRIMARY.appId)], OUTSIDER);

    for (const jwt of [memberOrgJwt, outsiderOrgJwt]) {
      for (const response of await Promise.all([
        request("DELETE", `/orgs/${PRIMARY.orgId}`, jwt),
        request("POST", `/orgs/${PRIMARY.orgId}/privacy/export`, jwt),
      ])) {
        expect(response.status).toBe(403);
        expect(((await response.json()) as ErrorResponse).code).toBe("FORBIDDEN");
      }
    }
    for (const response of await Promise.all([
      request("POST", `/apps/${PRIMARY.appId}/privacy/export`, memberAppJwt),
      request("POST", `/apps/${PRIMARY.appId}/privacy/entities/export`, memberAppJwt, entityBody()),
      request("POST", `/apps/${PRIMARY.appId}/privacy/entities/delete`, memberAppJwt, entityBody()),
    ])) {
      expect(response.status).toBe(403);
      expect(((await response.json()) as ErrorResponse).code).toBe("INSUFFICIENT_SCOPES");
    }
    // Scope-valid outsider JWT with no live App membership is FORBIDDEN, not
    // self-contradicting INSUFFICIENT_SCOPES (SPL-298).
    for (const response of await Promise.all([
      request("POST", `/apps/${PRIMARY.appId}/privacy/export`, outsiderAppJwt),
      request(
        "POST",
        `/apps/${PRIMARY.appId}/privacy/entities/export`,
        outsiderAppJwt,
        entityBody(),
      ),
      request(
        "POST",
        `/apps/${PRIMARY.appId}/privacy/entities/delete`,
        outsiderAppJwt,
        entityBody(),
      ),
    ])) {
      expect(response.status).toBe(403);
      expect(((await response.json()) as ErrorResponse).code).toBe("FORBIDDEN");
    }
  });

  it("limits unavailable privacy request status to its requester, owner, or App admin", async () => {
    const requesterJwt = await token([], REQUESTER);
    const ownerJwt = await token([`org:${PRIMARY.orgId}:owner`], ORG_OWNER);
    const adminJwt = await token([appAdminScope(PRIMARY.appId)], APP_ADMIN);

    for (const jwt of [requesterJwt, ownerJwt, adminJwt]) {
      const response = await request("GET", `/privacy/requests/${PRIVACY_REQUEST_ID}`, jwt);
      expect(response.status).toBe(503);
      expect(((await response.json()) as ErrorResponse).code).toBe("SERVICE_UNAVAILABLE");
    }

    for (const jwt of [await token([]), await token([], OUTSIDER)]) {
      const response = await request("GET", `/privacy/requests/${PRIVACY_REQUEST_ID}`, jwt);
      expect(response.status).toBe(403);
      expect(((await response.json()) as ErrorResponse).code).toBe("FORBIDDEN");
    }

    for (const jwt of [
      await token([], ORG_OWNER),
      await token([`org:${SECONDARY.orgId}:owner`], ORG_OWNER),
      await token([], APP_ADMIN),
      await token([appAdminScope(SECONDARY.appId)], APP_ADMIN),
    ]) {
      const response = await request("GET", `/privacy/requests/${PRIVACY_REQUEST_ID}`, jwt);
      expect(response.status).toBe(403);
      expect(((await response.json()) as ErrorResponse).code).toBe("FORBIDDEN");
    }
  });
});

function token(scopes: string[], userId = USER, authDoor?: string): Promise<string> {
  const now = Math.floor(NOW_MS / 1000);
  return h.signer.sign({
    sub: userId,
    iss: "https://auth.splitch.test",
    aud: AUDIENCE,
    iat: now,
    exp: now + 3600,
    scopes,
    ...(authDoor ? { auth_door: authDoor } : {}),
  });
}

function request(method: string, path: string, jwt: string, body?: Record<string, string>) {
  return h.app.request(path, {
    method,
    headers: {
      authorization: `Bearer ${jwt}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function entityBody(): Record<string, string> {
  return { idType: "user", targetingKey: "subject_route_contract" };
}

async function seedAppMember(
  bindings: LocalBindings,
  appId: string,
  userId: string,
  role: "owner" | "admin" | "member",
): Promise<void> {
  await bindings.d1
    .prepare("INSERT INTO app_memberships (app_id, user_id, role, created_at) VALUES (?,?,?,?)")
    .bind(appId, userId, role, "2026-07-18T12:00:00.000Z")
    .run();
}

async function seedPrivacyRequest(
  bindings: LocalBindings,
  values: { requestId: string; orgId: string; appId: string; requestedBy: string },
): Promise<void> {
  await bindings.d1
    .prepare(
      "INSERT INTO privacy_requests (request_id, org_id, app_id, request_type, subject_type, subject_ref, requested_by, status, received_at, ack_due_at, response_due_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(
      values.requestId,
      values.orgId,
      values.appId,
      "export",
      "app",
      values.appId,
      values.requestedBy,
      "received",
      "2026-07-18T12:00:00.000Z",
      "2026-07-19T12:00:00.000Z",
      "2026-08-18T12:00:00.000Z",
    )
    .run();
}

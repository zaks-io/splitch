import { type ErrorResponse, routeRegistry } from "@splitch/contracts";
import { createRepository } from "@splitch/db";
import type { RateLimiter } from "@splitch/worker-runtime";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { makeControlPlaneAuthResolver } from "./auth-resolver";
import { type FixtureSigner, makeFixtureSigner } from "./fixture-signer";
import { makeJwksVerifier } from "./jwks-verify";
import { appAdminScope } from "./scope-binding";
import { makeSessionStore } from "./session-store";
import { type LocalBindings, makeLocalBindings, seedOrgApp, seedOrgMember } from "./test-fixtures";

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
const allowLimiter: RateLimiter = () => ({ limited: false });

interface Harness {
  app: Hono;
  bindings: LocalBindings;
  signer: FixtureSigner;
}

let h: Harness;

beforeEach(async () => {
  const bindings = await makeLocalBindings();
  await seedOrgApp(bindings.d1, PRIMARY);
  await seedOrgApp(bindings.d1, SECONDARY);
  await seedOrgMember(bindings.d1, { orgId: PRIMARY.orgId, userId: USER, role: "member" });
  await seedOrgMember(bindings.d1, { orgId: SECONDARY.orgId, userId: USER, role: "member" });

  const signer = await makeFixtureSigner();
  h = {
    app: createApp({
      authResolver: makeControlPlaneAuthResolver({
        verifier: makeJwksVerifier({
          fetchJwks: async () => signer.jwks,
          controlPlaneAudience: AUDIENCE,
        }),
        sessions: makeSessionStore(bindings.kv),
        now: () => NOW_MS,
      }),
      rateLimiter: allowLimiter,
      repo: createRepository(bindings.d1),
    }),
    bindings,
    signer,
  };
});

afterEach(async () => h.bindings.dispose());

describe("control-plane route contract", () => {
  it("mounts every Control Plane-owned registry route", () => {
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

  it("limits organization discovery to the token's scope", async () => {
    const jwt = await token([`org:${PRIMARY.orgId}:member`]);
    const response = await h.app.request("/orgs", {
      headers: { authorization: `Bearer ${jwt}` },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      items: [expect.objectContaining({ id: PRIMARY.orgId, name: PRIMARY.orgName })],
    });
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
});

function token(scopes: string[]): Promise<string> {
  const now = Math.floor(NOW_MS / 1000);
  return h.signer.sign({
    sub: USER,
    iss: "https://auth.splitch.test",
    aud: AUDIENCE,
    iat: now,
    exp: now + 3600,
    scopes,
  });
}
